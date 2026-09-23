import Link from "next/link";

import { auth } from "@/auth";
import { signOutAction } from "@/lib/auth/actions";

/**
 * Who is signed in, and the way out, for the top nav.
 *
 * A server component handed to `Shell` as a slot rather than rendered by
 * `Shell` itself: `app/error.tsx` is a client component that renders `Shell`,
 * and a client module cannot import one that reads the session.
 *
 * The email is shown, not just a sign-out button, because every account starts
 * out looking the same — empty — and "why are my collections gone?" was really
 * "you signed in as someone else".
 *
 * Sign-out is a <form> posting a server action, so it works with JavaScript
 * off; a link would be a GET, and a GET that ends a session can be triggered by
 * any page that embeds it as an image.
 */
export async function Account() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return <Link href="/signin">sign in</Link>;

  return (
    <>
      <span className="who">{email}</span>
      <form action={signOutAction} className="signout">
        <button type="submit">sign out</button>
      </form>
    </>
  );
}
