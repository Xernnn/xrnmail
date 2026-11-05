# How xrnmail works

## Shape

```
Gmail (IMAP) ──> source.ts ──> sync.ts ──> store.ts (SQLite) ──> service.ts ──> IPC ──> page
                                               batches.ts decides when a message may be seen
```

`service.ts` holds everything the app does, with the clock and the network passed in, so whole days
of batches run in tests. `index.ts` only connects it to Electron.

## Read-only, by construction

`MailSource` has no method that changes anything. `ImapSource` opens All Mail with `EXAMINE` and
refuses to go on if the server didn't open it read-only, and fetches use `BODY.PEEK` so mail doesn't
get marked as read. Tests record every command the fake Gmail receives and check none could write.
Opening a thread marks it read on this laptop only.

Sending, archiving and labelling are the next stage. They need a real account to test against, and
they'll have to widen this interface deliberately.

## Sync

Every three minutes, and on waking, each account connects, syncs and logs out. Batching means nothing
is in a hurry, so there's no held-open connection to look after.

A pass fetches what's missing, newest first, then applies label and flag changes (CONDSTORE), then
forgets what's gone. It reads All Mail with Gmail's labels and thread ids, so a message is one row
however many labels it has, and spam and trash never arrive.

- `UIDVALIDITY` changing means every stored UID now points at the wrong message, so that account
  starts over, keeping the moment holding began.
- IMAP `SINCE` compares dates in the server's zone, so mail within two days of the window's edge is
  neither taken for deleted nor refetched.
- A message over 4 MB is cut at that length, which usually loses only attachments, and says so.
- Attachments are listed but not kept.

## Batches

`batches.ts` is pure, and every read in `store.ts` takes `now`, so a waiting message simply isn't
there: not in the list, a thread, search, label counts or a snippet.

The clock for everything is when Gmail received the message. The `Date` header isn't used, since a
sender can write what they like there.

- Only new inbox mail waits. Mail from before the account was added, your own, and what a filter
  filed away are there at once.
- Mail that arrived while the laptop was off is measured from when it arrived, so it's simply there.
- Changing the times moves waiting mail to the next slot after now, so a change can't deliver
  anything early. Turning batches off, or adding a sender to the straight-through list, does.

## Hostile mail

A stranger writes every email, and the window holds a bridge to all of them. So there are several
walls, and `e2e/mail.spec.ts` sends a hostile message through them.

1. DOMPurify, without forms, frames, objects, SVG or `<base>`.
2. A frame with `sandbox` and no `allow-scripts`. It has `allow-same-origin` only so the page can size
   it and catch clicks; with no scripts inside, nothing can use that.
3. A CSP in the frame with no network, widened to images only when asked.
4. The main process cancels every request from the page, whatever the CSP says, except images while
   "Show images" is on. That resets on leaving the thread.
5. Links go through a scheme allowlist before reaching the system, and hovering shows where one goes.
6. No navigation, new windows, downloads, permissions or webviews, and the bridge answers only the
   app's own page.

Packaged builds also drop Electron's Node and debugging entry points (`electron-builder.yml`).

## Secrets

App passwords are encrypted by the system keyring through `safeStorage`. Linux's `basic_text` fallback
is a key built into every Chromium, so it counts as no keyring and adding an account is refused. The
page never receives a password.

Mail itself sits in `mail.sqlite` in the app's profile, readable only by this user, and isn't
encrypted. Full-disk encryption covers that.

## xrnhub

Optional. `POST /api/events` with Basic auth over https (or to this machine), and never following a
redirect, which would carry the password elsewhere. Only counts and times are sent:

```json
{"app": "xrnmail", "kind": "state.held", "at": 1790000000000, "value": 3,
 "detail": {"held": 3, "nextBatch": 1790003600000}}
```

`batch` and `early` are things that happened, and appear on the hub's timeline. `state.*` feeds its
card. A hub that's down changes nothing here.
