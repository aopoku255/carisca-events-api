import { z } from 'zod';

/**
 * Password policy: length over composition rules. A 12-character passphrase
 * beats "P@ss1!" and users stop writing them on sticky notes.
 */
const password = z.string()
  .min(12, 'Use at least 12 characters.')
  .max(200, 'That password is too long.');

const email = z.string().trim().toLowerCase().email('Enter a valid email address.').max(190);

export const registerSchema = z.object({
  email,
  password,
  firstName: z.string().trim().min(1, 'First name is required.').max(80),
  lastName: z.string().trim().min(1, 'Last name is required.').max(80),
  phone: z.string().trim().max(32).optional(),
  countryCode: z.string().trim().length(2).toUpperCase().optional(),
  organization: z.string().trim().max(160).optional(),
  jobTitle: z.string().trim().max(160).optional(),
  timezone: z.string().trim().max(64).optional(),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password.'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'A refresh token is required.'),
});

export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'A verification token is required.'),
});

export const emailOnlySchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'A reset token is required.'),
  password,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  newPassword: password,
});

export default {
  registerSchema,
  loginSchema,
  refreshSchema,
  verifyEmailSchema,
  emailOnlySchema,
  resetPasswordSchema,
  changePasswordSchema,
};
