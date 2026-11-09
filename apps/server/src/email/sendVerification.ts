// Best-effort verification email via SMTP.
//
// Same shape as sendInvite.ts — when no SMTP is configured (DB or env,
// see transporter.ts) the function returns false without throwing.
// Unlike an invite, there's no copy-paste fallback surfaced in the API
// response (a verification link isn't something the registering user
// already has any other way to get), so the register route also logs
// the link when SMTP isn't configured — see routes/auth/password.ts.

import { getTransporter } from './transporter.js';
import { escapeHtml } from '../utils/validate.js';

interface SendVerificationEmailArgs {
  to: string;
  verifyUrl: string;
  /**
   * 'verify' (default): confirm a new account's address. 'set-password':
   * the account has no password and no other way to sign in, so the link
   * signs it in to choose one.
   */
  purpose?: 'verify' | 'set-password' | 'reset-password';
}

export async function sendVerificationEmail(args: SendVerificationEmailArgs): Promise<boolean> {
  const resolved = await getTransporter();
  if (!resolved) return false;
  const { transporter, config } = resolved;

  // verifyUrl is always server-generated (env.publicUrl + a random hex
  // token — see routes/auth/password.ts), so there's no real injection
  // path here, but it's escaped anyway for consistency with
  // sendInvite.ts's html body and as cheap defense-in-depth.
  const safeUrl = escapeHtml(args.verifyUrl);

  if (args.purpose === 'reset-password') {
    const subject = 'Reset your password — Collaborative Brick Layout Designer';
    const text =
      `Someone asked to reset the password of your Collaborative Brick Layout Designer account.\n\n` +
      `Open this link to choose a new one:\n\n${args.verifyUrl}\n\n` +
      `This link works once and expires in 1 hour. If you didn't ask for it, you can ignore this email; your password stays the same.\n`;
    const html =
      `<p>Someone asked to reset the password of your Collaborative Brick Layout Designer account.</p>` +
      `<p><a href="${safeUrl}">Choose a new password</a></p>` +
      `<p style="color:#888">Or paste this URL into your browser: ${safeUrl}</p>` +
      `<p style="color:#888">This link works once and expires in 1 hour. If you didn't ask for it, you can ignore this email; your password stays the same.</p>`;
    await transporter.sendMail({ from: config.from, to: args.to, subject, text, html });
    return true;
  }

  if (args.purpose === 'set-password') {
    const subject = 'Set your password — Collaborative Brick Layout Designer';
    const text =
      `Your Collaborative Brick Layout Designer account doesn't have a password yet.\n\n` +
      `Open this link to sign in and choose one:\n\n${args.verifyUrl}\n\n` +
      `This link expires in 24 hours. If you didn't ask for it, you can ignore this email.\n`;
    const html =
      `<p>Your Collaborative Brick Layout Designer account doesn't have a password yet.</p>` +
      `<p><a href="${safeUrl}">Sign in and choose a password</a></p>` +
      `<p style="color:#888">Or paste this URL into your browser: ${safeUrl}</p>` +
      `<p style="color:#888">This link expires in 24 hours. If you didn't ask for it, you can ignore this email.</p>`;
    await transporter.sendMail({ from: config.from, to: args.to, subject, text, html });
    return true;
  }

  const subject = 'Verify your email — Collaborative Brick Layout Designer';
  const text =
    `Welcome to Collaborative Brick Layout Designer!\n\n` +
    `Confirm your email address to finish setting up your account:\n\n${args.verifyUrl}\n\n` +
    `This link expires in 24 hours.\n`;
  const html =
    `<p>Welcome to Collaborative Brick Layout Designer!</p>` +
    `<p>Confirm your email address to finish setting up your account:</p>` +
    `<p><a href="${safeUrl}">Verify my email</a></p>` +
    `<p style="color:#888">Or paste this URL into your browser: ${safeUrl}</p>` +
    `<p style="color:#888">This link expires in 24 hours.</p>`;

  await transporter.sendMail({
    from: config.from,
    to: args.to,
    subject,
    text,
    html,
  });
  return true;
}
