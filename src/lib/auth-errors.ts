type SignInError = { status?: number; name?: string; message: string };

export const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password.";
export const SERVICE_UNREACHABLE_MESSAGE =
  "We can't reach the sign-in service right now. Check your connection and try again.";
export const RATE_LIMITED_MESSAGE = "Too many attempts. Wait a moment and try again.";

/**
 * The message the sign-in form shows. A wrong password and an unconfirmed
 * email stay one generic message (distinguishing them would be a
 * user-enumeration oracle), but a failure that is not about the credentials
 * at all must not be reported as one: telling someone their password is wrong
 * when the service is unreachable sends them off to reset a password that is
 * fine.
 */
export function signInErrorMessage(error: SignInError): string {
  const status = error.status ?? 0;
  if (status === 429) return RATE_LIMITED_MESSAGE;
  const unreachable =
    status === 0 || status >= 500 || error.name === "AuthRetryableFetchError" || /failed to fetch|fetch failed|network/i.test(error.message);
  return unreachable ? SERVICE_UNREACHABLE_MESSAGE : INVALID_CREDENTIALS_MESSAGE;
}
