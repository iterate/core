// cloud-scopes.ts — THE SCOPES THIS MIND'S CONNECTS ASK FOR, through each of iterate Cloud's apps.
// The Dash's "Connect", "Add account" and "Connect again" buttons read it (apps/dash/app.ts).
//
// The key is the Cloud's name for the app: `google`, `x`, `github` or `slack`. The value is the
// whole scope string of that app's connects, with spaces between the scopes. An app with no entry
// gets the Cloud's default scopes (its `/.well-known/iterate-cloud`, the client's `scopes`).
//
// A secret keeps the scopes it was connected with. After a change here, a member presses "Connect
// again" on the account's row of the Dash's Integrations page.
//
// Google with Drive and Docs. Keep the Gmail and Calendar scopes: without them the mailbox's and
// the calendar's push ends. Google shows its "unverified app" page for Drive and Docs until
// iterate's app is verified for them.
//
//   google: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.labels https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents",
//
// X as the person's own account: post, send direct messages, like, follow, upload media. X bills
// iterate for each call.
//
//   x: "tweet.read tweet.write users.read dm.read dm.write like.read like.write follows.read follows.write offline.access media.write",
export const CLOUD_SCOPES: Record<string, string> = {};
