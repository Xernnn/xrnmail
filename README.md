<p align="center">
  <img src="resources/icon.svg" width="72" height="72" alt="">
</p>

<h1 align="center">xrnmail</h1>

All your mail accounts in one place, delivered in batches. Gmail, Outlook, Yahoo, iCloud or any IMAP
server sit side by side, and mail lands a few times a day instead of whenever someone sends it, with
the people who matter coming straight through. Or, with one switch, it all shows the moment it
arrives.

It's a full mail client: write, reply, archive, delete, snooze. Your mail stays on your laptop and with
your mail service, with no server of ours in between. Everything clever happens on your laptop.

It looks and works like Edison Mail for Mac, in its own code: the same window (sidebar, a title and
search across the top, the list, the reader with Reply and Forward at its foot), the same rows and
quick actions, the same sections in Settings and the same keys. What xrnmail adds on top is listed
under [Where it differs from Edison Mail](#where-it-differs-from-edison-mail).

## What it does

- **Every account at once:** one inbox across services, or each on its own, with a colour for each,
  shown as a broad bar beside every row of a list they share and beside the subject of an open thread.
  Gmail keeps its labels and threads; other services get their folders, and threads worked out from
  the messages. Aliases work too, and a reply goes out from the address the mail came to.
- **As it arrives, or in batches:** one switch in Settings, Batches. As it arrives, new mail shows within
  seconds of your mail service having it, and so does what you do on your phone. In batches, new inbox
  mail waits for the next slot (09:00, 13:00, 17:00 by default), and waiting mail stays out of the
  list, threads and search until then. Switching keeps your times for coming back to. See
  [Live mail](#live-mail).
- **Straight through:** addresses or whole @domains that skip the wait, set in Settings or from a
  message's menu.
- **Deliver now:** works a set number of times a day, after a 30-second wait.
- **Writing:** reply, reply all, forward with attachments, formatting, signatures, templates, drafts
  that survive a restart, and addresses suggested from your mail. Replying starts from the buttons at
  the foot of a thread, in the composer, or the one beside each message, which replies to everyone on
  it if Settings, General say so. A reply or forward closed as it opened, with nothing written, leaves
  no draft behind.
- **Drafts in your service's Drafts:** a draft is kept on this laptop at once and in the account's
  Drafts a few seconds after you stop typing, so the phone has it, and one started on the phone turns
  up here to carry on with. Sending or throwing it away takes it off there too. Offline it waits and
  catches up. Changed in both places, both are kept. See [docs/design.md](docs/design.md#drafts-on-the-server).
- **Undo send and send later:** a message waits 10 seconds by default before it leaves.
- **Sorting mail:** archive, delete, spam, flag, labels or folders, read and unread, all kept in step
  with the server, one thread or many at once, with Undo. It keeps working offline and catches up.
  Once the open thread is archived or deleted, the next one opens, or the one before, or the list
  comes back, as Settings, General say. Marking it unread closes it, so nothing else gets read.
- **Reading:** a thread is read as it opens, or after a few seconds open, or only when you mark it
  read (Settings, General), so going down the list to look reads nothing by the way. In Unread the
  open thread keeps its place while it's read, so `j` goes on to the one below.
- **Trash and Spam:** read them, restore from them, or delete for good.
- **Pinned:** pin a thread from its menu, a row's menu, or by dropping it on Pinned, and find it
  there afterwards. A pin is this laptop's own note: the mail service isn't told, and flags stay free
  for what they mean there.
- **Recently Seen:** the threads you've opened, the last one first, wherever they are now: archived
  ones stay, and what's in Trash or Spam waits there. It keeps the last hundred, on this laptop only,
  and its right-click menu clears it. Reading from the list itself leaves its order as it is.
- **Focused and Other:** people on one side, and everything sent to everyone on the other, in each
  account's inbox. Say which side a sender belongs on and it stays there. All Inboxes is every
  account's inbox whole, with nothing set aside, and its count is all of it.
- **Assistant:** packages with their tracking, travel, bills and receipts, and events, found in your
  mail on this laptop. Calendar invitations can be answered from the message.
- **Subscriptions:** everyone mailing you in bulk, with how much of each one's mail gets read, and
  Unsubscribe, Add to Summary and Delete all next to each. Sorted by who sends most, by how much is
  read, or by name, and for one account or all. Pick several to put them into the Summary at once
  (or take them out), and open a sender for their page: how much they send, how much came in the
  last week, how much is read, what to do about them, and their mail. The ones left behind and the
  ones in the Summary have sides of their own.
- **The Subscription Summary:** chosen senders' new mail waits, and lands together, daily or weekly at
  the time you pick (the first sender added asks; Settings, Summary changes it or turns it off).
  Senders go in from Subscriptions or a message's menu. When it lands, one notice says so, and the top
  of the inbox has one entry for it until it's read. Its mail is under Summary in the sidebar, each
  Summary under its own heading with Delete all, and stays out of the inbox and its counts.
- **Sender warnings:** forged mail, lookalike addresses, a name showing a different address, replies
  going somewhere else. It warns; it never vouches.
- **Message details:** "To: me ⌄" over a message opens everything about it, as Edison's header does
  and with what Gmail's details add: From, Reply-To, To, Cc and Bcc (on your own copies), the full
  date and the one the sender wrote if it's far off, the account and where it is, the address it was
  delivered to, mailed by and signed by, TLS, the SPF, DKIM and DMARC results the receiving server
  wrote down, the mailing list with Unsubscribe, whether you've written to the sender, and the
  warnings. Every address can be selected, copied, written to, searched for, muted, let straight
  through or blocked from there. Escape or a click elsewhere closes it.
- **Snooze:** a thread comes back when you say, or when someone replies. Later today, This evening,
  Tomorrow, the weekend and Next week mean what Settings, General say (3 hours on, 18:00, and 9:00 on
  the next day, Saturday and Monday to start with), for snoozing and sending later alike. Later
  today is offered only while it's still today, and This evening only before it comes.
- **Clearing out:** one-click unsubscribe, and blocking a sender or a whole @domain.
- **Muted senders:** their mail arrives as usual and nothing announces it. From a message's menu, or
  Settings, Notifications.
- **Tracker blocking:** invisible images and known open-trackers are removed, even after Show images.
- **Attachments:** fetched when you ask, saved or opened. Anything that can run is saved, never opened.
  A row in the list shows its thread's files as small cards, unless Appearance says not to.
- **Windows of their own:** the last button over a thread opens it in its own window, and the
  composer's does the same for what you're writing. A thread's window follows it into Trash and back,
  and what's typed in a composer is kept when its window is closed.
- **Search:** finds Vietnamese without its marks, so `lich thi` finds "Lịch thi". Also `from:`,
  `subject:`, `to:`, `after:2026-01-31`, `before:`, `has:attachment`, `is:unread`, `is:read`, `is:flagged` and `in:inbox`.
  The empty box offers the last eight searches (finished with Enter, or a result opened from them),
  picked with the arrow keys and Enter, and each can be removed, or all with Clear. They're kept on
  this laptop.
- **Faces:** a sender's photo, or their company's logo, where one exists, as in Edison Mail, and
  coloured initials otherwise. Your own accounts show your photo in the sidebar and Settings, from
  Gravatar or one you choose there. Who is asked about whom, and when, is under
  [Faces, and what they tell whom](#faces-and-what-they-tell-whom).
- **Safe with hostile mail:** no scripts, and no remote images until you ask. See
  [docs/design.md](docs/design.md).
- **Quoted text folded away:** a reply shows what's new, with `•••` for what it quotes, and previews
  in the list do the same.
- **Comfortable to live in:** four quick actions on a row under the pointer and a short and a long swipe
  each way (all of them yours to choose in Settings, Customize Actions), a bar of actions under a
  selection (its ⋮ labels or files every thread picked, pins them, or moves them to Other or Focused),
  drag to the sidebar, right-click menus (on the sidebar: mark all as read, and Edit Menu to
  choose which of its entries show and in what order, each account's own labels or folders among them,
  with New Label or New Folder to make one on the server), recipient chips, the message beside the
  list or under it (each split dragged to the size you like, and kept) or one thing at a time, one to
  four lines of preview, and Settings you can search.
- **Stays with you:** new mail is announced as it lands, and clicking the notice for a message opens it
  in the inbox. With Focused and Other, mail in Other can arrive unannounced (Settings, Notifications).
  The tray shows what's unread, and closing the window keeps it running. Spell check knows your
  language, plus English and Vietnamese.
- **Light or dark**, or whatever the system says. In the dark, mail made for a white page is darkened
  to match: light backgrounds go dark and dark text light, each keeping its colour, while pictures,
  anything drawn on a picture, and mail that's dark already stay as sent. Each message has Show
  original colours, and Settings, Appearance can turn it off.
- **xrnhub:** optional, and gets counts only.

## Using it

Enter your address and xrnmail works out the service, from the address or the domain's public mail
records. Reading and sending are both checked before anything is kept, and passwords go in your system
keyring.

- **Gmail, Yahoo, iCloud, AOL, Fastmail, Zoho:** an app password from the service. The button in the form
  goes to the right page.
- **Outlook and Microsoft 365:** Microsoft doesn't accept passwords any more, and only lets a registered
  app sign in. Registering one is free and takes a few minutes in
  [Microsoft Entra](https://entra.microsoft.com): allow personal and work accounts, turn on public client
  flows, add the delegated permissions `IMAP.AccessAsUser.All` and `SMTP.Send`, and paste its Application
  ID into xrnmail. You then sign in on Microsoft's own page with a code.
- **Anything else:** your password and the server's details. Only encrypted connections are accepted.

Press `?` for the keys. The set is Edison Mail's, with Command read as Ctrl: `c` or `d` writes, `r` or
Ctrl+R replies, Backspace takes a thread out of view (archives it), Shift+Backspace deletes, Ctrl+S
flags, Shift+I marks read. The keys xrnmail had before still work beside them (`j` and `k` move, `e`
archives, `#` deletes, `z` undoes). Settings, Shortcuts has the other sets Edison offers: Gmail's
(xrnmail's old keys alone, where Delete deletes), Apple Mail's, Outlook's and Inbox's, each from its
maker's list with Command read as Ctrl. Any action's key can be changed there: press Change, then the
new key. A key another action has is offered to take over, and a change can go back to the set's own.
Ctrl+N, Ctrl+F, Ctrl+Enter and F5 are the menu's and the composer's in every set.

To have mail links open here, set it as your mail app after installing:
`xdg-mime default xrnmail.desktop x-scheme-handler/mailto`.

## Live mail

With Settings, Batches set to **As it arrives**, mail is live: there's no button to press and nothing
to wait for.

- **How:** each account keeps one connection open on its inbox, read-only, in IMAP IDLE
  ([RFC 2177](https://www.rfc-editor.org/rfc/rfc2177)). The server speaks up the moment a message
  lands there, leaves it (archived or deleted on your phone or the web), or is read or flagged
  elsewhere. Within a second xrnmail runs its ordinary sync for that account, so what you see is
  what the server has. A burst of changes, like a phone marking thirty messages read, is one sync.
- **The rest of the account** (Sent, labels, folders) is read every three minutes, on waking from
  sleep, and when the window comes back after a minute away. A watch that drops is opened again
  after a minute, and the three-minute passes go on regardless, so nothing is missed meanwhile.
- **Why not Gmail's own push:** Gmail's [push notifications](https://developers.google.com/workspace/gmail/api/guides/push)
  go through Google Cloud Pub/Sub and the Gmail API, which need an OAuth sign-in and a Google Cloud
  project of your own. xrnmail signs in to Gmail with an app password over IMAP, and IMAP has IDLE,
  which Gmail supports. Outlook's push
  ([Microsoft Graph change notifications](https://learn.microsoft.com/en-us/graph/change-notifications-overview))
  needs a public web address for Microsoft to call, and Graph permissions beyond the IMAP and SMTP
  ones xrnmail asks for, so Outlook is watched over IMAP IDLE too.
- **In batches** mail is watched the same way, and then waits for its time. The Subscription Summary
  waits for its own time either way.

## Faces, and what they tell whom

Finding a picture for someone means asking somebody else, so this is all that's asked, and of whom:

- **Gravatar** (gravatar.com, run by Automattic), for each sender and for your own accounts: the
  SHA-256 hash of the address, never the address itself, asking for a 96-pixel photo. Gravatar sees
  your IP address and when you asked, and can tell whose hash it is for an address it already knows.
- **DNS**, through your usual resolver, for a sender with no Gravatar on a company's domain: the TXT
  record `default._bimi.<domain>`, then the same for the company domain above it
  (`e.shop.example`, then `shop.example`). That's where a company publishes its
  [BIMI](https://bimigroup.org/) logo.
- **Whoever hosts that logo**, named in the record, often the company itself or a certificate
  authority such as DigiCert or Entrust: one fetch of the SVG.
- **DuckDuckGo's icon service** (`icons.duckduckgo.com`, no account or key; Clearbit's free logo
  service closed in December 2025), for a company with no BIMI logo: the domain name, for its site's
  icon. Free mail domains (gmail.com, outlook.com, yahoo.com and the like) never get a logo, so a
  friend on Gmail doesn't get Gmail's, and nor do your own addresses.

When: as new mail from someone arrives here, or when they're first named in a list (a row of the
inbox, search, Subscriptions and the rest). Never when a message is opened, so nobody learns when
you read anything. A face found is kept for 30 days in the profile's `faces` folder, "none" for 7,
and a lookup that failed is tried again after 6 hours, so each person and company is asked about
rarely. Every request is https to a public name, with no cookies or redirects, 8 seconds and 200 KB
at most (64 KB for SVG), and what comes back has to be a picture by its own bytes. PNG and JPEG are
drawn again, smaller, by Chromium's decoder in the main process, so nothing but pixels is kept;
an SVG is only ever shown as an `<img>`, where it can neither run nor fetch anything. Pictures in
messages are as before: blocked until you ask.

A face proves nothing: anyone can publish one for their own address or domain. Mail with a sender
warning shows initials, whatever pictures there are.

Your own accounts: Google has no way to get a Google account's profile photo without signing in
with OAuth. The People API needs it, and the old Picasa address that answered by email was shut down
in 2019. These accounts sign in with app passwords, so your photo is your Gravatar, or one you choose
in Settings, Accounts, which stays on this laptop and is sent nowhere.

## Where it differs from Edison Mail

Kept from xrnmail, where Edison has nothing: batches and straight-through senders (As it arrives,
which is how Edison always works, is one switch away), the delivery line
over the list, Snoozed and Attachments in the sidebar, search without Vietnamese marks, sender
warnings, xrnhub, and the one-thing-at-a-time layout.

Not here, though Edison has them:

- Settings' Labels, Back up & Sync and Privacy pages, which Edison's pictures name but don't open.
  Back up & Sync would need a server of Edison's.
- From Appearance: the Scaling slider (View's zoom does that here).
- From General: how long Undo lasts after archiving and the rest (5 seconds, as Edison's pictures
  have it set) and Show only one undo; which of Cc and Bcc a new message shows; whether a reply
  quotes the original; conversations newest first; replies opening in a window of their own; Gmail's
  importance markers; and a count beside Unread, which here is the inbox's unread and would only
  repeat the inbox's count. Today has its count, of what came today and is unread.
- View original: a message's source, with Download. The source isn't kept on this laptop, so it would
  be fetched from the server.
- A message's own ⋮ has Reply all and Forward here. Edison's also has Pin Thread, Trash, Mark as
  Unread, Add sender to Summary, Mute notifications and Move to Other, which here are over the thread,
  under ⋮ More, or in "To: me ⌄". The ⋮ on the bar under a selection has Labels or Move to, Pin and
  Move to Other here, but not Mark as important (Gmail's importance isn't read here at all).

Done differently:

- Settings and the sync status sit at the foot of the sidebar, because Linux hides the menu bar
  Edison keeps its Preferences in. Appearance has an Edit Menu button beside the right-click one.
- A pinned thread stays where it is in its list and is gathered under Pinned. Whether Edison also
  lifts pinned mail to the top of a list isn't shown anywhere, so it isn't done.
- The composer starts as a panel in the window and moves to a window of its own when asked; Edison's
  is always a window.
- A thread's own window stays open when the thread is archived or deleted, showing it where it went
  with Undo still there, and closes when it's marked unread or gone for good.
- Muted senders are a list of addresses or @domains typed in or added from a message, as blocked
  senders are; Edison picks them from contacts.
- How the Summary and batches sit together is xrnmail's, since Edison has no batches. A sender in the
  Summary waits for its time, not the next batch, and does with batches off; Deliver now is for the
  batch and leaves it waiting. Letting a sender straight through takes them out of it, and adding one
  to it takes them off that list; an address in one beats its @domain in the other. Its mail stays in your service's inbox: only this laptop shows it
  apart.
- The Inbox set is from Inbox's own Shift+? list, as people who used it wrote it down, since Google's
  help page only ever said to press Shift+?. Apple's page leaves out deleting, flagging and searching,
  so those are from Mail's menus. Outlook's is Outlook for Mac's.
- In Edit Menu a label moves among the ones beside it, taking what's inside it along, and hiding one
  hides what's inside it. An account's All Mail, Sent and the rest stay where they are. Making a label
  or folder goes to the server there and then, so it needs a connection, where other changes wait.
- A changed key is one key for its action, in place of all the set's keys for it.
- Edison's Focused Inbox is one switch for everything, and in its pictures All Inboxes is split too,
  with All Other beside it. Here the switch (Settings, General) is the same one, but it splits only
  each account's own inbox: All Inboxes shows every account's mail together, Other included.
- Edison finds faces on servers of its own. Here they come from Gravatar, BIMI and DuckDuckGo's icons,
  asked from this laptop, and a sender with a warning keeps their initials.
- A draft from your service's Drafts, written on the phone say, brings its words in as plain text and
  what it quotes as it was quoted, since its HTML is the service's and can carry a stranger's. A draft
  changed on two devices before either heard of the other is kept twice, so neither's words are lost.
  Edison doesn't say what it does then.
- A sender's figures are counted from the mail kept on this laptop (90 days by default), and "read"
  is read anywhere, by what your mail service says, since nothing here can know what was opened.
  Edison works out its open rate on its own servers. Picking several is by the tick box beside each,
  or with Ctrl or Shift, where Edison's phone app holds a finger down.
- Recently Seen is a reading of its name. Edison's sidebar has it, after All Sent, in every picture,
  and nothing it publishes says what it lists. Here it's a history of the threads opened.
- Of General's choices, Edison's pictures show only the one each is set to. "When mail is Archived or
  Deleted" shows Open next; Open the one before and Go back to the list are xrnmail's. "Mark as read
  after" shows Instantly; here there are 1, 2 and 5 seconds, and only when marked. "Default reply
  behavior" shows Reply All, with the button beside each message drawn as Reply All; here that's
  what it decides, and the foot of a thread keeps both buttons and the keys keep their own.
- Edison's help says notices can be for Focused alone; here that's Only mail in Focused, under
  Notifications, while the inbox is split. Its badge setting to match isn't here: the tray counts
  everything unread.
- Edison's layouts are Reading Pane Right, Reading Pane Bottom and Full Screen; here they're Layout's
  side by side, Message under the list, and One thing at a time (Settings, General).
- Edison's Adaptive Coloring is Darken mail made for a white page here (Settings, Appearance), with
  Show original colours on each message darkened. How Edison darkens isn't published; here the
  colours are moved one by one, never the pictures.
- On the bar under a selection, Labels adds a label to every thread picked (taking one off is a
  thread at a time), and labels and folders need the threads to be from one account. Move to Other
  and Move to Focused keep each picked thread's sender on that side, since that's how Focused and
  Other are decided here.
- Recent searches are as Edison's phone app has them (https://9to5mac.com/?p=837422); its Mac app's
  pictures show only the box.
- Snooze isn't in the Mac app's pictures, and reviews say it had none; Edison's phone app snoozes to
  Later today at 18:00, Tomorrow at 9:00 and Next week on Monday at 9:00, each changeable. Here Later
  today is some hours on (3 to start with) and This evening is its own choice, and each time can be
  changed in Settings, General. On a Saturday or Sunday the weekend to come is next weekend's.

## What it doesn't do yet

- The tests use fake servers, and it has hardly been used with real accounts yet. Expect surprises from
  real ones, Outlook's sign-in most of all.
- No mail rules, translation, or written summaries of what mail says, and nothing is built for Windows or
  macOS or for phones.
- The Assistant reads machine-readable facts first, then strict patterns in English and Vietnamese. It
  will miss things: a wrong entry is worse than a missing one.
- Search covers the mail kept on this laptop (90 days by default, up to three years in Settings).
- A scheduled message goes out when the app is running at or after its time. Closing the window keeps
  it running; Quit doesn't, though anything only waiting out Undo goes before it closes.

## Building

```sh
npm install
npm run build && npm start     # run it
npm run app:install            # build an AppImage and add it to the launcher (Linux)
```

## Tests

```sh
npm test            # logic, against fake IMAP and SMTP servers over real sockets
npm run test:e2e    # the built app, including a hostile email
npm run typecheck
```

`SHOTS=<folder> npx playwright test shots` takes pictures of the app with made-up mail.
