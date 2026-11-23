# How xrnmail works

## Shape

```
server (IMAP) ──> source.ts ──> sync.ts ──> store.ts (SQLite) ──> service.ts ──> IPC ──> page
                                               batches.ts decides when a message may be seen
                                               assistant.ts sorts it and finds what's in it

page ──> service.ts ──> store.ts, at once ──> pending queue ──> writer.ts ──> server (IMAP)
                   └──> drafts ──> sender.ts ──> server (SMTP)
                          └──> draft copies ──> writer.ts ──> the account's Drafts (IMAP)
```

`service.ts` holds everything the app does, with the clock and the network passed in, so whole days
of batches run in tests. `index.ts` only connects it to Electron.

## Accounts and services

Gmail and everything else disagree about what a message is. Gmail keeps one copy in All Mail with labels
saying where it shows. Everywhere else a message lives in one folder, and moving it gives it a new UID.
The app is built around the second, with Gmail as the case where nearly everything is in one box.

A row is `(account, box, uid)`. `box` is `@role` for special folders (`@all`, `@inbox`, `@sent`,
`@archive`, `@trash`, `@junk`), so a renamed or translated folder stays the same box, and the path for
ordinary ones. `labels` holds what the message would have on Gmail, worked out from the box elsewhere,
so most code doesn't need to know which it's looking at. `bin` says Trash or Spam, and ordinary reads
filter on `bin = 0`.

- Which kind a server is comes from what it says it can do (`X-GM-EXT-1`), not from what it's called, so
  a Workspace account on a company's own domain is treated as Gmail. `AccountView.labels` tells the page
  whether to offer labels or a Move menu.
- Gmail reads All Mail, Trash and Spam. Other servers read every folder except All Mail, Drafts and
  ones that only collect what's elsewhere, and what some servers show that isn't mail.
- Threads on other servers are the hash of the first Message-ID in `References`, so a thread can span
  folders. `Store.thread` shows a message once when it's in two.
- Servers without CONDSTORE can't say what changed, so flags are read again each pass.
- Connections are `tls` or `starttls`, and STARTTLS is required rather than tried, so a server that stops
  offering it never gets the password. Plain text isn't accepted from the form. The fake servers use a
  value that only code can set.
- Outlook has no passwords, so it signs in with the device-code flow and XOAUTH2. The Application ID is
  the person's own: reusing another mail app's would be pretending to be that app. Each account keeps
  the ID it signed in with, because its renewals work with no other. The refresh token goes in the
  keyring like a password, and access tokens stay in memory. Only Microsoft refusing a renewal outright
  asks to sign in again. Busy, failing and rate-limited answers (5xx, 429, `temporarily_unavailable`)
  are waited out like a lost connection, and mail due to go stays queued.

## Reading and changing are kept apart

Syncing can't change anything. `MailSource` has no method that does, `ImapSource` opens every folder with
`EXAMINE` and refuses to go on if the server didn't open it read-only, and fetches use `BODY.PEEK` so
mail doesn't get marked as read. Tests record every command the fake servers receive and check that a
sync sends none that could write.

Changes go through `MailWriter`, which is small on purpose and runs on its own connection, only for
something the person did. imapflow answers `false` rather than throwing when a command fails, so
`ImapWriter` checks every answer: an unchecked one would report a change the server refused.

## Changes

An action applies to `store.ts` at once, so the app never waits on the network, and joins the `pending`
table. That's what lets it survive being offline or a restart. Anything that takes mail out of view,
and any other change the page offers Undo for (Move to Inbox, a label added from a selection, Mark
all as read), waits out Undo (5 seconds, or up to 30 as Settings, General say) and one second more
before setting off, since a change already sent can't be called back; everything else goes straight
away.

- Only mail that can be seen is touched. A held reply in the same thread is left alone.
- `MailService.inLane` runs one thing at a time per account. A sync reading the server while a change is
  on its way could otherwise put back what was just archived. Messages with a change still waiting are
  skipped when applying what the server says, and the next sync picks up the true state.
- The queue holds row ids, not UIDs, and the folder and UID are looked up as each change goes out. A move
  renumbers a message, so a star queued behind an archive would otherwise reach nothing, or the wrong
  message. After a move the row follows it using the server's `COPYUID` answer. Without one, or when
  it's gone somewhere not read here, the row is dropped and the next sync finds it again.
- On folder servers an action on a thread touches the part of it that makes sense: archive takes what's
  in the inbox, not your own copy in Sent. Delete for good only ever reaches mail already in a bin.
- A lost connection loses nothing: the change goes again later, in order. A refusal is retried twice,
  then the message is put back as it was and the sidebar says so.
- Moves use `UID MOVE` where the server has it, and copy then delete where it doesn't. A service with no
  Archive or Trash folder gets one the first time it's needed.
- On Gmail, mail brought back from Trash or Spam is moved to All Mail and labelled Inbox there, rather
  than moved to `INBOX`: All Mail is read and the server names the new UIDs there, so the row follows
  it and the thread is in the inbox at once, not only after the next sync.
- Delete and spam change the row's `bin` at once, which is what makes Undo possible. `hidden` is only for
  mail being deleted for good, and Gmail's own unsent drafts. Every read leaves out hidden rows, as it
  does held ones.
- Snoozing is kept here only (`snoozes`), and Gmail isn't told. A thread is away while `until` is ahead
  and nothing newer has landed in it, so a reply wakes it. It sorts by `until` once it's back.
- A pin is kept here only as well (`pins`, by thread). IMAP has no mark for it, and a flag already
  means something on the server. Pinned lists pinned threads from everywhere but Trash and Spam, and
  a pinned thread keeps its place in every other list.
- Recently Seen is this laptop's own as well (`recent`, by thread, with when it was last opened). The
  page opens a thread through the same call whatever list it's in, and that call notes it, except
  from Recently Seen itself, so the list doesn't reorder under the pointer or under j and k. The
  newest hundred stay. It lists threads from everywhere but Trash and Spam, as Pinned does.
- A muted sender's mail is left out by both things that announce mail: a sync that finds mail
  already due neither counts nor names it, and a delivery counts only what the others sent. It
  lands, and refreshes the list, like any other.

## Sending

Mail goes through the service's SMTP server with the same sign-in. Gmail and Outlook file their own copy
in Sent; for the rest it's added afterwards, unless the server turns out to have done it, which is
checked by Message-ID. Failing to file a copy leaves a note and is never a reason to send again. A draft
has a state: `draft`, `queued`, `sending` or `failed`. Send only queues it with a `send_at`, which
is all Undo and "send later" are. `tick()` sends what's due.

**A message is never sent twice on a guess.** A duplicate to a real person is worse than asking.

- `SmtpSender` connects and signs in as its own step first, since that's the one failure that proves
  nothing left. nodemailer reports a connection lost after the message was handed over the same way as
  one that never opened, so its error codes can't be used for this. Only that first step is retried.
  The message goes on that same connection (nodemailer's `SMTPConnection`, not its transport, which
  opened one connection to check and another to send, so the network going between the two failed a
  message that never left as "check Sent"). A sign-in answered with a 4xx is that first step failing
  too: SMTP's "not now".
- A message that can't be put together, an attachment gone from the profile say, fails before
  anything is handed over (`Unmade`), and says so plainly: nothing went, so it isn't "check Sent".
- Any later failure ends in `failed`, with "check Sent". The state is written as `sending` once
  signed in, before the message is handed over, so a crash comes back the same way instead of as a
  retry. Until then it's still `queued`: a quit during a slow connect, which finishing up gives up on
  after eight seconds, leaves it to go next time rather than to be checked for.
- A draft that ends in `failed` stays in Drafts with what went wrong, and the account says "Sending
  failed" in the sidebar until it's sent or thrown away. The page says "Sent" only once the draft has
  gone, never when it's queued.
- **Nothing goes that the person took back.** Until a draft is marked `sending` it can be called back,
  changed or thrown away, and sending the ones due before it can take a while. So `sending` is only
  written if the draft is still queued and due at that moment, and what goes is the draft as it is
  then, never as it was when the round began.

Attachments are copied into the profile when chosen, so a message scheduled for later doesn't depend
on where the file was.

## Drafts on the server

A draft is kept here first, as before: the composer saves it within a second of typing, offline or
not, and that copy is the one that's sent. It's also kept in the account's Drafts folder, the one
marked `\Drafts` (on Gmail, `[Gmail]/Drafts`, which Gmail shows as Drafts on the web and the phone),
as Edison keeps it. `remote-drafts.ts` says what goes up and what's made of what comes down;
`service.ts` decides when.

- **What goes up** is the whole message as it would go: the words, the signature, what it quotes,
  its attachments and its Bcc, with `\Draft` and `\Seen`, so another device can carry on with it or
  send it as it is. Nobody has to be on it yet. A new message with nothing in it isn't kept there.
- **When.** Once it has been left alone for four seconds, or once it has been changing for a minute,
  so typing doesn't send every keystroke and a long stretch of it is still kept. Saving what's there
  already changes nothing, so closing a composer untouched sends nothing up. On the account's own
  lane, like changes to mail, and only through the writer.
- **Replacing a copy** is APPEND first, then the old copy deleted by its UID, so there's never a
  moment with none. The UID comes from the server's APPENDUID, or without UIDPLUS from the newest copy
  with the Message-ID just given, which is new for each version. Gmail moves what's deleted from
  Drafts into Trash and keeps it a month, so there the old copy is moved to Trash and deleted from
  Trash, which is for good; elsewhere it's deleted where it is. A server with no Drafts folder gets one.
- **A copy that has to go** (the draft was sent, thrown away, moved to another account or emptied)
  is noted in `draft_copies` and goes as soon as the server can be reached, like the pending queue:
  offline, or after a restart, nothing is lost. Refused three times, it's let go of and said.
- **Thrown away** from the composer or Drafts, a draft with something in it leaves Drafts at once and
  goes for good, with its copy, once Undo has had its time, or when the app closes; until then
  nothing about it changes on the server, and one that was waiting to go waits as a draft, so it
  can't leave meanwhile. Undo gives it back as it was. A crash meanwhile keeps it.
- **Sending** takes the copy off at once, not when the message leaves: a message on its way isn't a
  draft, and one still in Drafts could be sent from the phone as well while this laptop waits out Undo
  or a later time. Undo makes it a draft again, and it goes up afresh. What's in the undo window or
  scheduled is never on the server as a draft.
- **Coming down.** Each sync reads the Drafts folder, read-only like the rest (`EXAMINE`,
  `BODY.PEEK`), after the mail. A copy it doesn't know, saved within the keeping window, comes in as
  a draft here, with its files. One with more than can be sent from here (about 18 MB of files) stays
  on the server, as one older than the keeping window does: brought in without its files and changed
  here, it would go back up without them. Its words go into the composer as text: the copy's HTML is the server's, may hold a
  stranger's quoted HTML, and never reaches the page. What it quotes is kept apart, as a reply's quote
  is, and goes out as it was quoted, not quoted again; the account's own signature comes off the end
  of the words, so a draft that went up from here and came back isn't signed twice.
- **Each draft here knows its copy**: the UID, the folder's UIDVALIDITY when it was had, its
  Message-ID, and which version of the draft it was made from (`pushed`). A renumbered folder finds
  its copies again by Message-ID instead of bringing them in twice.

### A draft changed in two places

There's no safe way to merge two edits of the same words, and choosing by the clock would throw
away what someone typed, on the word of two devices' clocks. So the rule is that nothing typed is
lost, and a change made in one place only is taken as it is:

- **Changed here only:** the laptop's version replaces the copy.
- **Changed on the other device only:** Gmail's phone app saves a draft by replacing its message, so
  the copy this laptop knew goes and a new one comes. The draft here hasn't changed since its copy
  went up, so it goes, and the new copy comes in as the draft: the other device's version wins.
- **Changed in both:** the copy this laptop knew has gone, and the draft here has changed since. It
  stays, and goes up as a draft of its own; the other device's comes in beside it. The person sees
  both and throws one away.
- **Sent or thrown away elsewhere:** the copy goes and nothing replaces it. Unchanged here, the draft
  goes too. Changed here meanwhile, it stays and goes up again: an edit is never thrown away, even if
  that leaves a draft of something already sent.
- **Open in a composer:** what the server says leaves it alone until the composer lets it go
  (`holdDraft`, released when its page goes, however it goes). A composer would otherwise be editing
  a draft that had been deleted under it, or write its own words over the other device's.

Draft ids are never given out twice (`AUTOINCREMENT`), since drafts now come and go behind the page's
back and a page holding an old id would otherwise mean a new draft by it.

On Gmail every draft is in All Mail too, labelled `\Draft`, and kept hidden there, as before. A
message that loses the label (the phone sending a draft it saved can do that) shows from then on.

## Sync

Every three minutes, on waking, and when the network changes, each account connects, syncs and logs
out. Batching means nothing
depends on being fast, so these passes are what the app relies on; watching the inbox, below, only
brings the next one forward.

A pass that can't reach the server is tried again after 5 seconds, then 15, 30 and 60 (`PASS_RETRY_MS`),
and after that the three-minute passes carry on as usual. Waking from sleep is often seconds ahead of
the Wi-Fi and the VPN, so the pass it starts fails as often as not; without the quick tries, "Couldn't
reach" stayed up for minutes after the network was back. Waking starts the tries over, and a pass
that gets through ends them. A refused password isn't tried again this way: asking again won't help.
A sign-in turned away because the server is busy isn't a refused password, though imapflow marks
any NO to LOGIN as one: RFC 5530's `[UNAVAILABLE]`, `[INUSE]`, `[LIMIT]` and `[SERVERBUG]`, and
Gmail's "Too many simultaneous connections", are waited out like a lost connection, and so is an
SMTP sign-in answered with a 4xx. Only that is read of what the server said; none of it is shown.
Anything else that gets through to the server (a change, a draft going up, a copy filed in Sent, a
message sent, a watch opening) takes "Couldn't reach" away too; any other error waits for a pass.

A sync asked for while one is running (waking, the window coming back, F5, the button) goes once
more when that one ends, however many times it was asked. The one running may be stuck on a
connection that died with the lid shut, and turning the asks away left its error up until the next
three-minute pass.

A pass goes through each folder in turn, inbox first. For each it fetches what's missing, newest first,
then applies label and flag changes, then forgets what's gone. A folder the server has stopped listing
is forgotten too, and an ordinary folder that refuses to open or to be searched is skipped rather than
stopping the rest.

- What's gone is whatever the folder's search didn't return, so a search that's turned down or cut off
  has to fail, and forgets nothing. imapflow answers those with `false` or nothing at all, and taking
  either for an empty folder would forget every message in it.
- Removing an account stops a pass that's under way at its next folder, batch or message, and anything
  it kept goes with the account. Otherwise a first sync carried on filling the shared inbox with mail
  from an account that was no longer there, and nothing would ever take it out.
- `UIDVALIDITY` changing means every stored UID in that folder now points at the wrong message, so that
  folder starts over, keeping the moment holding began.
- When a message lands is worked out as it's stored, from the settings as they are then, not as they
  were when the pass began: signing in and fetching can take seconds, and a sender put into the
  Summary, let through or blocked meanwhile, or mail going live, must hold what the pass stores
  after it. `retime` sees only what's already stored.
- IMAP `SINCE` compares dates in the server's zone, so mail within two days of the window's edge is
  neither taken for deleted nor refetched.
- A message over 4 MB is cut at that length, which usually loses only attachments, and says so.
- Mail is read on a thread of its own (`parser.ts`), so a long backfill doesn't make the window
  stutter. A message that takes over 20 seconds to read is kept as one that can't be read, as any
  other that fails is, and the thread, stuck on it, is replaced; left alone it held the account's
  pass, and so its changes, drafts and Sent copies, until the app restarted. It isn't tried again
  on the main process, where it would hang the window too.
- Attachments are listed but not kept. They're fetched whole when asked for, and read with `BODY.PEEK`:
  64 MB of a message at most, past the 50 MB Gmail delivers, so a server can't have the laptop
  hold more. A message bigger than that says it's too big to open here.
  A cut message lists only the files in the part that was kept, so its list is marked (`files_cut`)
  and made again from the whole message the first time it's opened, one message of a thread at a
  time, since each takes a connection. A forward takes the files of the
  whole message, whatever the list says.
- Gmail's own unsent drafts are in All Mail too. They're kept hidden, so a thread doesn't show them.

### Watching the inbox

One more connection per account sits on `INBOX`, opened read-only, and waits in IDLE. It reads nothing:
when the server says something landed (`exists`), left (`expunge`: archived or deleted on another
device), or had its flags changed (`flags`: read or flagged elsewhere), it asks for an ordinary sync,
so there's still one way into the store and the batches apply as usual. It waits until the server has
been quiet for 750 ms first, so a burst of news is one sync. If the sync is already running it's asked
to go again afterwards, because what changed may have missed it. The watch has its own connection, so
a sync never interrupts its IDLE; imapflow breaks IDLE every five minutes (`maxIdleTime`) and starts
it again, as it does after anything else on that connection. A lost connection is retried after 2
seconds, then 10 and 30, then every minute, and the three-minute passes carry on regardless, so
watching can fail without anything being missed. A watch that opens again after being lost asks for
a sync at once, since IDLE only tells of what happens from then on, and takes away "Couldn't reach",
since the server has just answered. A watch that fails partway, signed in but turned away at the inbox, closes its connection:
left open, every minute's try added one, until the service refused the account for having too many.

Live or in batches is one setting (`BatchSettings.live`). Live, the rules a sync and `retime` use have
no batch times, so nothing waits for a batch and the next delivery is none, which hides the delivery
line and Deliver now; the Summary keeps its own time. The batch times stay saved for switching back.
Settings saved before the switch existed are live exactly when they have no times, which is how they
behaved; batches always have a time, so taking the last one away is going live.

There's one watch per account, counted from when it starts signing in. Waking from sleep, or the
network changing, replaces them all, and an old one finishing its goodbye only ever clears its own
place, so a wake can't leave a connection running that nothing will close. Gmail allows fifteen at
once.

### The log of failures

Every connection that fails (a pass, a watch, a change, drafts, a copy for Sent, a message sent)
adds a line to `sync.log` in the profile, so "Couldn't reach" can be looked into afterwards:

```
2026-11-23T01:02:03.456Z gmail:3f2a9c sync connect CONNECT_TIMEOUT 30012ms ipv4 142.250.4.108:993 timeout, ipv6 [2404:6800:4003:c00::6c]:993 no answer
```

The account is its service and the first six hex of a SHA-256 of its address. The stage is how far
the connection got (`dns`, `connect`, `tls`, `greeting`, `login`, `command`, `idle` for a watch
that had opened, `smtp`). Only codes are kept, Node's (`ECONNREFUSED`), imapflow's
(`GREETING_TIMEOUT`), the IMAP status and response code (`NO [UNAVAILABLE]`) or an SMTP reply's
number, each checked to be a short code: a server's words, which could carry anything, never go in.
The addresses tried come from Node itself: `imapClient` and `SmtpSender` connect inside
`noteAttempts`, and every socket opened meanwhile is followed through the `net.client.socket`
diagnostics channel, each address with what came of it (`up`, `timeout` for Node's per-address
wait, an error code, or `no answer` when the whole connection gave up first). That's the line that
would have shown the VPN's IPv4 tries dropped after 250 ms and the IPv6 one swallowed. Past 256 KB
the file becomes `sync.log.1` and a new one starts. A log that can't be written changes nothing.

### Noticing the network change

Linux tells an app nothing when a VPN reconnects, its kill switch comes up or the Wi-Fi changes, and
a socket on the old route can take a minute to find out. So `network.ts` reads the interfaces and
their addresses every 5 seconds (one system call) and, when they've changed and held for 2 seconds,
does what waking does: every watch starts again, the quick tries start over, and every account
syncs. The loopback isn't counted, nor the order the system lists them in.

### Mail from before the window

Only the keeping window is read, so a search would never find anything older. It asks the servers as
well (`server-search.ts`), on read-only connections through `MailSource` like a sync. The search box
shows what's kept here at once, and 500 ms after the text last changed every account is asked about
mail from before the window: Gmail with `X-GM-RAW` over All Mail, in Gmail's own language and mostly
as typed (`gmailQuery`), anything else with IMAP SEARCH in each folder but Trash and Junk
(`imapPlan`), where a term without a SEARCH key is tried on the headers that come back. Both ask
only about mail from before the window starts (to the next day, since a server's days are its own),
so held mail stays out, and what's kept here already is left out of the answer.

- Only the newest 200 found on each account are read, and only their headers (`HEADER.FIELDS`, with
  `BODY.PEEK`), which is all a row needs. Their rows go below what's kept here, once that's all shown.
- A new search, or leaving search, drops the connections of the one before at once, mid-command,
  rather than waiting for a slow server to answer what nobody's asking any more.
- A server that can't be reached, or won't search, adds nothing and says nothing: the search is what's
  kept here, as it was before servers were asked.
- Opening a row it found, or acting on one, fetches its thread first (`reach`, before `thread` and `act`
  in the main process): on Gmail everything with its X-GM-THRID in All Mail, elsewhere whatever in a
  folder sync reads names its first Message-ID (`Message-ID`, `References` or `In-Reply-To`), kept only
  if it works out to the same thread. They're stored as ordinary rows, so the reader, Reply, every
  action, attachments and Save as .eml work on them by folder and UID as on any, and listed in
  `outside` with when they were last opened. No list, count, contact or subscription reads them but
  their own thread, Pinned and Recently Seen. The keeping step at the end of a pass lets them go a
  week after they were last opened, unless their thread is pinned, and once the window has grown to
  take them in they're ordinary mail. What's in the window of such a thread is left for a sync.

## Staying open

Closing the window hides it while the tray exists and "Keep running in the tray" is on, so
notifications and mail set for later still work. Without a tray there would be no way back, so the app
quits instead. Quitting properly runs `finishUp`: mail only waiting out Undo goes now, as do pending
changes, within eight seconds. Mail scheduled for later stays scheduled; its time hasn't come, and
sending early would be worse than sending late.

### Notices

Electron's Notification has no actions on Linux, so a notice for one message (`notifier.ts`) goes to
the desktop's notification server through `notify-send` with Open, Archive and Mark read, after
`gdbus` has asked the server whether it shows actions at all (asked again every ten minutes, since the
server can be restarted or swapped). notify-send waits on the bus and prints the action chosen, and
because it's the connection that sent the notice, it hears servers that tell only that connection
(dunst, Plasma) as well as those that tell everyone (mako, Quickshell); a `gdbus monitor` beside a
one-off `gdbus call` would miss the first kind. Archive and Mark read go through `act`, as the
thread's buttons do, so they work with the window closed. A notice for several messages, a Summary's,
and any desktop without notify-send, gdbus or actions keep Electron's plain notice, whose click opens
the window. Both programs run without a shell, the words after `--`, and the body has `&`, `<` and `>`
escaped, since a server may read it as markup. At most six notices wait on a button; the oldest stops
waiting, and quitting stops them all.

With Sound on, each notice plays `resources/new-mail.wav` through `pw-play`, or `paplay` where that
fails, so it's heard with the window closed. It's two bell notes made from sine waves by
`scripts/make-chime.mjs`, so no one else's recording is in the app, and it's unpacked from the archive
with the icon so a player outside the app can read it. Only mail that's announced makes it: a muted
sender's, an account with its notices off, and Other while only Focused is announced make none.

## The Assistant

`assistant.ts` decides Focused or Other, and finds parcels, travel, bills and events. It runs as mail is
stored, on this laptop, and sees only that message. The services this replaces do it on their servers by
reading your mail, which is the part not copied.

Facts senders put there on purpose come first: calendar invitations, and the schema.org data airlines,
hotels and shops include for inboxes to read. Patterns come after, in English and Vietnamese, kept strict
because a wrong entry is worse than a missing one, and they aren't applied to bulk mail at all.

A stranger wrote all of it, so it's held to the same standard as the mail:

- The data is parsed as JSON and never run. Everything found is shown as text.
- It can't supply a link. "Track" goes to an address built here from the carrier and a number that
  must be plain letters and digits.
- It can't stall the app. Sorting runs in the main process during sync, so patterns over a message are
  bounded and the awkward parsing is done by hand. A pattern that backtracks over two megabytes of a
  stranger's HTML would hang everything, and `tests/assistant.test.ts` keeps the messages that would.
- An invitation's answer goes to its organizer only if that's one plain address, and it's a draft like
  any other, so it waits out Undo and goes through the same door. Nothing goes out unless a button is
  pressed.

Sender warnings only ever warn. They read the `Authentication-Results` lines the account's own
server wrote, and a pass is never shown as a mark of trust. A server names itself at the start of
its line (its authserv-id, RFC 8601 §5), so only lines with the account's server's name count
(`receiverOf` in parse.ts): Gmail's are `mx.google.com` (so are a Workspace account's), Microsoft's
name nobody, Yahoo, AOL, iCloud, Fastmail and Zoho sign under their own companies, and any other
server under the company its IMAP server or the address belongs to. The top line counts if it's
the server's, and so do the ones straight under it that the same server wrote under other names
(iCloud writes one per check); the first naming anyone else, or a name already read, is where a
sender's own begin, since servers put theirs on top. A failure is taken from the top line whoever
wrote it, since a sender can only forge one against themselves. What a pass from those lines does:
it lets the pictures of a sender trusted for them load by themselves (`shared/images.ts`), lets a
company's logo show (Faces), and lets a list's headers excuse replies going elsewhere.

- **Forged:** DMARC failed, or SPF and DKIM both did.
- **Unverified:** SPF failed or soft-failed, and neither DMARC nor a DKIM signature of the From
  line's domain spoke for it, as a spoof of a domain without DMARC is.
- **From you:** your own address on mail the server checked and couldn't tie to your domain, by
  DMARC, a DKIM signature or an SPF pass for it. What you sent never came in from outside, so it
  has no such line and gets no warning.
- **Name and address:** a name showing another address, a name with hidden characters (below), and
  a domain with characters that can imitate others.
- **Replies elsewhere:** Reply-To at another company, by the part of a domain that's bought
  (`organization`), so bank.com.au and evil.com.au differ. List-Id, Precedence and Auto-Submitted
  are the sender's own words, so they excuse it only on mail proved to be the sender's.

Names, subjects and attachment names lose, as a message is read, the characters that turn text
around (U+202A–202E, U+2066–2069), the marks that steer it (U+200E, U+200F, U+061C) and what draws
nothing at all (`plainName`); the body keeps them, as the sender wrote it. U+202E turned
`moc.lapyap@ytiruces` into a bold "security@paypal.com", and the check for a name showing another
address saw it backwards, so a name that had any of the first kind is warned about. Names are drawn
in `<bdi>`, so even a right-to-left one can't move the address beside it.

A message's details show those results all the same, as Gmail's details do, labelled as what the
receiving server wrote down (`details.ts`). The same care is taken reading them: comments and quoted
strings are dropped before a result is looked for, only the account's server's
`Authentication-Results` (as above; none when the top line isn't its), the top `Delivered-To` and the
topmost `Received` line that names where it came from are read, every value is
cut short and stripped of control and bidirectional characters, and all of it is shown as text. They
are kept with the message when it arrives (`details`, as JSON). Mail stored before that has none; the
first time its details are opened its header alone is fetched, with `BODY.PEEK[HEADER]` so nothing
is marked read, and kept. Copying an address goes through the main process, which takes only
something shaped like an address, so a page gone wrong can't put a command on the clipboard to be
pasted into a terminal.

## Batches

`batches.ts` is pure, and every read in `store.ts` takes `now`, so a waiting message simply isn't
there: not in the list, a thread, search, label counts, a snippet, the Assistant or subscriptions.

The clock for everything is when the server received the message. The `Date` header isn't used, since a
sender can write what they like there.

- Only new inbox mail waits. Mail from before the account was added, your own, and what a filter
  filed away are there at once. That includes Spam and Trash, which also count for nothing in the
  "waiting" figure, in search, or in contacts.
- Mail that arrived while the laptop was off is measured from when it arrived, so it's simply there.
- Changing the times moves waiting mail to the next slot after now, so a change can't deliver
  anything early. Going live, or adding a sender to the straight-through list, does, and the hub
  hears at once that nothing is waiting.

### The Subscription Summary

`holdOf` decides a message's moment, in this order: mail that never waits (from before the account,
not in the inbox, your own) is there at once; a sender in the Summary waits for its next time, daily
or on its weekday; one let straight through doesn't wait; everyone else waits for the next batch.
Named in both lists, the narrower naming wins: an address in one beats its @domain in the other, so
a newsletter domain can wait for the Summary while one writer there comes straight through, and the
other way round. The same address can't be in both, since adding to one takes it off the other; from
settings older than that, the Summary wins. Times are on the clock, so a Summary lands at its time
on the day after a change of clocks, and one set for an hour that's skipped lands an hour later.

A message held for the Summary is marked (`summary`), and stays marked once it lands, so a Summary is
simply the marked messages with the same `release_at`. The inbox and its counts leave marked mail out,
and the Summary list is the marked mail still in the inbox, by when its Summary landed. Nothing about
this reaches the server, where the mail sits in the inbox as usual.

- The waiting count, the next delivery and Deliver now are the batch's alone, so Deliver now delivers
  what it says and the Summary keeps its time. The Summary's own count and next time are beside them.
- Adding a sender moves what they have waiting for a batch to the Summary; taking one out, or turning
  the Summary off, sends what it holds of theirs back to the batches. A new time moves what's waiting
  to it. All of these go through the same `retime` as the batch times, measured from now.
- A tick tells about a batch and a Summary apart (`landed`, `summarized`), so a Summary is one notice
  for all it brought. A sync that finds a Summary already landed, after the laptop was off at its
  time, says so the same way instead of announcing its mail as new. Muted senders count in neither.
- xrnhub hears only about batches.

## Hostile mail

A stranger writes every email, and the window holds a bridge to all of them. So there are several
walls, and `e2e/mail.spec.ts` sends a hostile message through them.

1. DOMPurify, without forms, frames, objects, SVG or `<base>`.
2. A frame with `sandbox` and no `allow-scripts`. It has `allow-same-origin` only so the page can size
   it and catch clicks; with no scripts inside, nothing can use that.
3. A CSP in the frame with no network, widened to images only when asked.
4. The main process cancels every request from the page, whatever the CSP says, except images while
   "Show images" is on. That resets on leaving the thread. Images can be set to always load, or for
   one sender at a time, but that only presses the same button for you: it goes through the same switch
   in the main process. The default is to ask. A sender's own load only on mail the account's server
   says is theirs, by DMARC or by a DKIM signature from their domain, since anyone can write their
   address on a From line; the rest asks, as a stranger's does.
5. Images that exist to report an open (invisible ones, and known tracking services) lose their `src`
   while DOMPurify cleans the message, so "Show images" can't set one off and a reply can't pass one on.
   It's done there, on the tree, because taking clean HTML apart and rebuilding it can undo the cleaning
   (`shared/trackers.ts`). Invisible is two pixels or less however it's written (`1`, `1px`,
   `max-width:1px`), or hidden. CSS is cleaned the same way, in style attributes and `<style>`: the
   known services' pictures, any picture a rule loads only under the pointer or on a click, and
   `@import`, and a cell's `background` from them goes too; `loading=lazy` is dropped, so a picture
   far down can't say how far you read. CSS can name a picture in more ways than that can find, so
   the main process refuses the known services' addresses even with Show images on. A picture sized
   to nothing by a class in a style sheet still loads once allowed.
6. Links go through a scheme allowlist before reaching the system, and hovering shows where one goes.
   A link whose words are an address or a domain at another company than the one it goes to, or
   whose address puts a name before an @ (`https://paypal.com@evil.example/`), asks first: "Go to
   evil.example?", with what it shows (`shared/links.ts`). Companies are told apart as for sender
   warnings, so a newsletter's own click-tracking under its domain doesn't ask.
7. No navigation, downloads, permissions or webviews, and the bridge answers only the app's own page.
   A page can't open a window. Only the main process does, for a thread or a draft, and that window
   is the same page with the same preferences (`pagePreferences`: sandboxed, isolated from the
   bridge's world, nothing of Node) behind the same walls, told in its address what to show.

Packaged builds also drop Electron's Node and debugging entry points (`electron-builder.yml`).

Writing and acting on mail gave strangers new things to aim at, so:

- **The editor holds only what's typed.** A quoted message would otherwise put a stranger's HTML in the
  app's own page, next to the bridge. The quote stays out of the editor, is sanitised on its way into
  the draft, and shows only in a sandboxed frame. Pasting is as plain text, for the same reason.
- **Every reply starts in the composer.** Reply, Reply All and Forward at the foot of a thread open it,
  with the recipients, the address it goes from and the quote on show before anything is sent. There's
  no box under a thread to type into, as Edison has none, so all of a reply is decided where it can
  all be seen.
- **Files enter a draft only through the system's picker, or as bytes that were dropped or pasted.** The
  page never names a path, so a compromised page can't attach `~/.ssh/id_ed25519` and send it. Being able
  to send mail is the new thing a compromised page could do, which is why this line is held so firmly.
- **Attachments are saved, or opened only if they can't run.** Linux picks the program for a file by
  its bytes, not its name: xdg-open asks `xdg-mime query filetype`, which looks inside, so a Java
  archive called `invoice.pdf` is typed as a Java archive and handed to `java -jar`. So a name is
  only the first test (`canOpenDirectly`, a list of documents, pictures, sound and film, plain text
  and archives). `opening.ts` then reads the bytes themselves, and refuses programs, scripts,
  launchers, Java archives under any name (a ZIP with a manifest, classes or the jar tool's mark),
  Office files with macros, and anything that renders as a page. Last, it asks `xdg-mime` what the
  written file is, run without a shell, and opens it only if that's a type of the same kind. With no
  `xdg-mime` the bytes decide alone, except for old Office files, whose container is also an
  installer's. Anything refused says "Save it to open", and a name that can't be opened saves
  straight away. What's opened is written to a folder of its own in the temporary folder, named so it
  can't be guessed and noted in the profile, and taken away when the app quits, or at the next start
  if it didn't get to. Saving asks before writing over a file. File names are cleaned before they're
  suggested, so `../../.ssh/authorized_keys` can't climb out.
- **Unsubscribing makes one fixed request.** The address comes from a stranger's header, so the app sends
  only the POST that RFC 8058 defines, without credentials or redirects, to https on a public name that
  resolves to no address of this laptop, its network or the tailnet (as faces' lookups check), and
  only when the button is pressed. Anything else opens in the browser. A mail-only sender gets a draft
  to read, never a message sent behind your back.
- **`mailto:` links only fill in a draft.** Whatever they ask for, including a Bcc, is on show first.
- **A mail file is a stranger's message with no server behind it.** `xrnmail some.eml` (or a file:
  URL, as a launcher's `%U` gives) reads only a plain file, never a pipe or a device, of 64 MB at
  most, parses it on the parser's thread and follows nothing in it (`letters.ts`). Its
  Authentication-Results lines are words anyone could have written, so it's unverified, never
  "from you", and no sender's pictures load by themselves. It's shown in a window of its own by a
  token (`solo.ts` `file`), as `Letter.tsx`: the reader with nothing to archive, flag or move, behind
  the same walls as mail. The page's calls for it (details, attachments, View original) use a number
  below zero, so they can't be taken for a stored message's, and it's let go when the window closes.
- **Blocking** matches the `From` address, which a sender writes, so it's a filter for nuisances and not
  a security wall. Mail it catches goes to Trash, where it can still be found.

## Faces

`avatars.ts` finds a picture for an address: the person's Gravatar, then their company's BIMI logo,
then DuckDuckGo's icon for the company's domain, and keeps what it found, or that it found nothing,
on disk (`faces/index.json` beside the pictures, readable only by this user): 30 days for a
picture, 7 for none, 6 hours after a lookup failed. A company is asked about once for all its
senders. Free mail domains and your own addresses get no logo. An account's chosen photo is kept
the same way, with no expiry, and wins over its Gravatar on every address of that account.

The index is only believed as far as it's the cache's own: an entry naming any file but one of the
cache's own picture names (32 hex characters and a known extension), or a type it doesn't know, is
left out, so a damaged or planted index can't have a file read from elsewhere or deleted when the
face is looked up again. A picture gone from the folder is forgotten, and looked up again when next
wanted, rather than showing initials until its month is out.

Each lookup tells someone something, so the rules are about when and how:

- **When.** Only a list's rows ask for lookups, for everyone they name. Mail arriving doesn't
  (the service's `noticed` is left unused): a lookup then told a sender, by a TXT query for a name
  only they used and a logo fetched from where they said, that the address works and when the mail
  got here, even for mail still waiting for its batch. The reader, the composer's suggestions and
  the drafts only ask what's already known (`faces(addresses, false)`), so opening a message never
  makes a request anyone else can see. Rows with a sender warning ask nothing for that sender and
  show initials. With Show faces off (`faces` in Settings), nothing is looked up and only an
  account's chosen photo shows; turning it off or on has the page ask for every face again.
- **Logos.** A company's logo, BIMI or site icon, is looked up and shown only for an address whose
  newest mail here passed DMARC by the account's own server (`Store.passedDmarc`), so for its own
  domain: a stranger writing a company's address gets initials, and any domain can name any SVG in
  its BIMI record, so one with no checks of its own can't put a bank's logo on its mail. A domain
  that passes its own DMARC still shows whatever logo it names: the certificate a BIMI record can
  point to (`a=`) isn't checked.
- **How.** The main process does all of it with Node's own fetch, which the page's network walls
  don't cover and don't need to. Only https to a public name that resolves to no private, loopback,
  shared (carrier NAT, Tailscale) or link-local address, GET, no redirects, no cookies, a time
  limit, and the body counted as it comes and dropped past its limit. The answer's type is taken
  from its bytes. BIMI is SVG only; Gravatar and icons are never SVG.
- **Showing.** The page gets a data: address, so it needs no network. PNG and JPEG are drawn again
  by `nativeImage` first, smaller and with nothing but pixels; one it can't read is no picture. Their
  size is read from their header before that (`pictureSize`), and one of more than four million
  pixels (a chosen photo, a hundred million) isn't drawn at all, since a few kilobytes of JPEG can
  say it's 60,000 pixels square and take gigabytes to decode in the main process. An
  SVG is shown only as an `<img>`, where scripts don't run and nothing loads, never placed in the
  page. A picture that fails to draw shows initials.
- **Testing.** The sources are passed in. Unit tests answer from lists, and the UI tests from files
  named in `XRNMAIL_PICTURES`; without them a test looks nothing up, so no test reaches the network.

## Secrets

App passwords are encrypted by the system keyring through `safeStorage`. Linux's `basic_text` fallback
is a key built into every Chromium, so it counts as no keyring and adding an account is refused. The
page never receives a password.

A password that's kept but can't be read, because the keyring wasn't open when the app first asked,
isn't gone. Chromium keeps that first answer until the app quits, so the sidebar asks to unlock the
keyring and restart, and mail due to go waits. Only a password that isn't kept at all, or that an open
keyring can't decrypt, asks for the account to be added again.

Mail itself sits in `mail.sqlite` in the app's profile, readable only by this user, and isn't
encrypted. Full-disk encryption covers that.

## Storage

`MIGRATIONS` in `store.ts` lists every change to the file in order, and `PRAGMA user_version` records how
far a file has come, so an update upgrades whatever's there. Shipped entries are never edited: a change
is a new entry. The `search` table is kept in step by hand, with no triggers.

## xrnhub

Optional. `POST /api/events` with Basic auth over https (or to this machine), and never following a
redirect, which would carry the password elsewhere. Only counts and times are sent:

```json
{"app": "xrnmail", "kind": "state.held", "at": 1790000000000, "value": 3,
 "detail": {"held": 3, "nextBatch": 1790003600000}}
```

`batch` and `early` are things that happened, and appear on the hub's timeline. `state.*` feeds its
card. A hub that's down changes nothing here.

## Reading what's quoted

Most of a reply is what it quotes. `splitQuoted` finds where a plain message starts quoting, walking
lines and testing short slices so a stranger's text can't stall it, and previews and the plain-text
body share it. Quoted lines only count as the quote when nothing new follows them, and where the last
new line is gets worked out once, from the end: asking again at every quoted line took minutes over
the half a megabyte of text a message keeps. HTML is different: taking clean HTML apart and putting it
back together is how sanitised markup gets turned hostile again, so nothing is removed. A class on the
frame's root hides the known quote markers with CSS, and the `•••` toggles that class. A forward keeps
everything, because the quote is what was sent.

## The page

The window is laid out as Edison Mail for Mac's is, rebuilt in this code from what can be seen of it:

- `Sidebar.tsx`: Compose and refresh, the inbox, the accounts (each unfolds its own folders and
  labels), the gathered folders in Edison's order, then the Assistant's lists. Right-clicking a place
  offers to mark all of it read, which asks the store for the whole list, not the rows on screen.
  Right-clicking anywhere offers Edit Menu: those last two lists turn into switches that can be
  moved, by their arrows or by dragging, each within its own list. The arrows sit one over the
  other so a name keeps its room: side by side, with the scrollbar a list with labels has, they cut
  "Recently Seen" and "Bills & Receipts" short at the sidebar's own width. The choice is a setting
  (`shared/sidebar.ts`). It's made whole each time it's read, so an entry a later version adds turns
  up after the one it follows, shown, in a choice saved before it existed. Each account's own labels
  or folders are switches there too, kept by account in the same setting: an order among siblings,
  so a label moves with what's inside it, and the ones hidden. What's listed is what the server lists
  on each pass (`MailSource.folders`: an account's own folders, or on Gmail its labels, which IMAP
  lists as folders), with any label found on mail that it doesn't. So an empty label shows, one made
  elsewhere turns up after the ones arranged, and one taken away goes. New Label and New Folder send
  CREATE on the account's writer connection, in its lane, there and then: it needs the server's yes
  before there's anything to show, and there's nothing to undo. A slash in the name nests it, joined
  with the server's own separator. The service's own names (INBOX, `[Gmail]`) and what IMAP can't
  name are turned down before anything is sent.
- `App.tsx`: the band with the view's title and search across list and reader, the list, the bar that
  floats under a selection, and what every key and button does. With several accounts, All Inboxes
  asks for the inbox with no side, so it's whole; an account's own inbox, or the only account's, asks
  for Focused or Other, and its Other tab counts that account's alone (`AccountView.otherUnread`).
- `List.tsx`: a row (face, sender with a dot while unread, subject, lines of preview), its quick
  actions and its swipes. Where several accounts share a list, which includes search, Recently Seen,
  the Summary and the gathered drafts, a row carries a bar of its account's colour down its left
  edge, six pixels wide so it reads at a glance; the reader puts the same bar beside the subject. A swipe is a short one or a long one each way: `swipeAction` decides from
  how far the row went.
- `Reader.tsx`: flat messages under the thread's actions, with Reply, Reply All and Forward on a bar at
  the foot. A message's details float under its header, as tall as what's visible of the thread
  allows and scrolling inside themselves past that; a message near the foot of a short window
  scrolls up first, with room added at the thread's end for it, so there's space to read them.
- A thread or a draft can have a window of its own (`showSolo` in the main process, `shared/solo.ts`
  for what its address says). It's `App` again, drawing only the reader or only the composer. The
  main window lets the thread go when it's opened there: two readers would each mark it read
  whenever it changed. A thread's window follows its thread into Trash or Spam and back, so the Undo
  for what moved it stays in reach, and it closes once the thread is nowhere and nothing is left to
  undo. Marking it unread closes it. A window that's being closed is told first (`leaving`), so its
  composer keeps what's typed, or takes away a draft with nothing in it, and then closes the window
  itself; one that doesn't answer in two seconds is closed anyway. A draft has one editor: opening
  it from Drafts while it has a window brings that window forward.
- `Find.tsx`: the find bar over a thread. Electron's `findInPage` searches the whole window, the
  list and sidebar beside the thread and the bar's own box with them, so the bar reads the thread's
  words itself: the open messages under `.messages` and each message's frame (same-origin, so its
  page can be read), a frame's words apart from the window's and a block's apart from the next.
  Matching is `shared/find.ts`, case and marks folded one character at a time so a match maps back
  to the text it came from. Matches are marked with the CSS Custom Highlight API in the page they're
  in, which changes nothing in a message's page, and only what's drawn counts. It finds again when the
  thread's page changes or a frame says it has drawn a new page (`xrn-shown`).
- `Settings.tsx`: Edison's sections, then xrnmail's own. What's typed into an account's name,
  signature and the rest is held once for every page until the field is left.

Settings are saved as changes, never as a whole copy put back. Each save names only what it changes
(`saveProfile`, `saveBatch` and `saveSummary` all take part of their settings, and an identity
replaces that one account's), and senders go into a list or come out of it one at a time
(`editSenders`), added to the list as the main process has it then, which is the only place that
changes it. Before this, a page built the whole list, or all four quick actions, from what it last
read: two changes made in quick succession both started from the same old settings, so the second
put the first back, and two senders added to the Summary one after the other kept one.

Settings goes through `shared/keeper.ts` as well. A change there is worked out from the settings with
every change before it already in them, shown at once, and sent after the ones before it. What's read
back from the main process is shown only when nothing is still on its way, since a reading taken
before a change would put its old value back on screen for the next change to start from.

What a row offers is all in settings, and `saveProfile` keeps it to what a row can show: none to four
lines of preview, four quick actions from a fixed list, a swipe action for each of the four swipes.
Rows saved as "compact" by an older version read as one line of preview.

Keys live in `shared/keys.ts`, apart from the page so they can be tested without one. `keyName` gives a
press a name ("e", "Shift+Backspace", "Ctrl+Shift+R"), and each set maps names to commands. The Edison
set is Edison Mail's own keys with Command read as Ctrl, plus the keys xrnmail already had where they
don't collide; the Gmail set is those older keys alone. Apple Mail's, Outlook's and Inbox's come from
their makers' lists. Command is read as Ctrl and Option as Alt; Control held with Command becomes Alt,
since Ctrl is taken by then, and Control alone stays Ctrl. Every set has the arrows, Esc and `?`. Keys
pressed inside a message's frame are passed on with their modifiers, so they reach the same table.

What a person changes is kept for each set apart (`keyChanges`), as one key for an action in place of
the set's keys for it, or none. `keysFor` lays the changes over the set, and a changed key wins: an
action that had it in the set loses it. That's what taking a key over from another action is, so the
conflict is settled by asking and then saving the change, with nothing else to keep in step. The keys
of the app's menu (Ctrl+N, Ctrl+F, F5 and the rest) and what a page needs for itself (Tab, Enter,
Ctrl+Enter) can't be taken, and saved changes are cleaned of them, of unknown actions and of a key
named twice. The Shortcuts page listens for the next press itself, ahead of the dialog, so Esc calls
off the choosing instead of closing Settings.

Subscriptions say how much of each sender's mail is read (`Subscription.read` over `count`, from the
`\Seen` flag, so read anywhere) and how much came in the last week, counted in the same query that
lists them. Sorting and showing one account's are done on the page. A sender's page is a list like
any other (`ListQuery` `from`: their threads on one account, wherever they are but Trash and Spam)
under a card that reads their figures again (`sender`) each time anything changes. Several senders
go into the Summary or out of it as one `editSenders`, so the first one in asks when it should land
once, and none is lost to another.

"Archive" in the sidebar is its own list: mail out of the inbox, out of Trash and Spam, and without the
Sent label. All Mail is still everything.
