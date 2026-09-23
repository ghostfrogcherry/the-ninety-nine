import type { OutboundMail } from "@/lib/auth/mail";

/**
 * The two messages this app sends, kept apart from the thing that sends them.
 *
 * Both carry a bearer credential in a URL, so they follow the same three rules:
 *
 *  - Say which host the link is for. A sign-in mail with no origin in it is
 *    indistinguishable from a phishing mail with a different one.
 *  - Say what to do if you did not ask for it, and say that ignoring it is
 *    enough. A "was this you?" mail that offers no reassurance makes people
 *    click the link to find out.
 *  - Put the URL in the plain-text part verbatim. Mail clients that show text
 *    only, and terminal clients in particular, are exactly the audience for a
 *    self-hosted card tracker.
 *
 * Interpolation into the HTML bodies is limited to the URL we generated and the
 * host parsed back out of it — no user input reaches these templates, which is
 * why plain concatenation is safe here and would not be if it did.
 */

const FOOT = "If you did not request this, you can ignore this email.";

const HTML_STYLE = "font-family:system-ui,sans-serif;line-height:1.5";
const MUTED = "color:#666;font-size:.9em";

/** Magic-link sign-in. Sent by the Auth.js email provider. */
export function signInEmail(to: string, url: string): OutboundMail {
  const { host } = new URL(url);
  return {
    to,
    subject: `Sign in to ninetynine (${host})`,
    text: `Sign in to ninetynine (${host})\n\n${url}\n\n${FOOT}\n`,
    html: `<body style="${HTML_STYLE}">
  <p>Sign in to <strong>ninetynine</strong> (${host}).</p>
  <p><a href="${url}">Click here to sign in</a></p>
  <p style="${MUTED}">${FOOT}</p>
</body>`,
  };
}

/**
 * Password reset.
 *
 * Two facts in the body that are not decoration. The expiry, because a user who
 * opens the mail tomorrow should know why the link is dead before they type a
 * passphrase into it. And the "only the newest link works" line, because
 * `issueResetToken` invalidates outstanding tokens — someone who clicks "send
 * it again" and then opens the first mail needs to know that is expected.
 */
export function passwordResetEmail(to: string, url: string, ttlMinutes: number): OutboundMail {
  const { host } = new URL(url);
  const window = `${ttlMinutes} minutes`;
  return {
    to,
    subject: `Reset your ninetynine password (${host})`,
    text:
      `Reset your ninetynine password (${host})\n\n${url}\n\n` +
      `The link expires in ${window} and can be used once. If you asked more ` +
      `than once, only the newest link works.\n\n` +
      `${FOOT} Your password has not changed.\n`,
    html: `<body style="${HTML_STYLE}">
  <p>Reset your <strong>ninetynine</strong> password (${host}).</p>
  <p><a href="${url}">Choose a new password</a></p>
  <p style="${MUTED}">The link expires in ${window} and can be used once. If you asked
  more than once, only the newest link works.</p>
  <p style="${MUTED}">${FOOT} Your password has not changed.</p>
</body>`,
  };
}
