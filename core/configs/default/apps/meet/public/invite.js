// invite.js — A CALENDAR INVITE for a meeting, built in the page: a link to Google Calendar's form
// for a new event, and an .ics file (RFC 5545). Pure: no DOM, so a test loads it in Node.
//
//   invite: { title, start: Date, minutes, link, uid, stamp: Date }
//
// `link` is the meeting's page, or a guest's share link with its secret: whoever holds the invite
// holds the link.

const QUARTER_MS = 15 * 60_000;

/** The default start: `now` rounded up to the next quarter hour. */
export const nextQuarter = (now) => new Date(Math.ceil(now.getTime() / QUARTER_MS) * QUARTER_MS);

/** A time in UTC as both formats write it: 20261119T103000Z. */
export const utcStamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

/** A local time as a `datetime-local` input shows it: 2026-11-19T10:30. */
export function localInput(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const endOf = ({ start, minutes }) => new Date(start.getTime() + minutes * 60_000);
const detailsOf = ({ link }) => `Join the meeting: ${link}`;

/** Google Calendar's form for a new event, filled in. */
export function googleCalendarUrl(invite) {
  const query = {
    action: "TEMPLATE",
    text: invite.title,
    dates: `${utcStamp(invite.start)}/${utcStamp(endOf(invite))}`,
    details: detailsOf(invite),
    location: invite.link,
  };
  const pairs = Object.entries(query).map(
    ([key, value]) => `${key}=${encodeURIComponent(value).replaceAll("%2F", "/")}`,
  );
  return `https://calendar.google.com/calendar/render?${pairs.join("&")}`;
}

/** A TEXT value of RFC 5545 (3.3.11): a backslash, a semicolon, a comma and a line end escaped. */
export const escapeText = (text) =>
  String(text)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");

/** One content line, folded at 75 octets of UTF-8 (RFC 5545 3.1): each line after the first starts
 *  with a space, which counts. A character is never split. */
export function fold(line) {
  const encoder = new TextEncoder();
  const lines = [];
  let current = "";
  let octets = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (octets + size > 75) {
      lines.push(current);
      current = " ";
      octets = 1;
    }
    current += character;
    octets += size;
  }
  lines.push(current);
  return lines.join("\r\n");
}

/** The .ics file's text: one event, its lines ended by CRLF. */
export function icsOf(invite) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//iterate//Meet//EN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${invite.uid}`,
    `DTSTAMP:${utcStamp(invite.stamp)}`,
    `DTSTART:${utcStamp(invite.start)}`,
    `DTEND:${utcStamp(endOf(invite))}`,
    `SUMMARY:${escapeText(invite.title)}`,
    `DESCRIPTION:${escapeText(detailsOf(invite))}`,
    `LOCATION:${escapeText(invite.link)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
