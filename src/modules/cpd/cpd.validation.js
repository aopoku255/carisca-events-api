import { z } from 'zod';

const iso = z.union([z.string().datetime({ offset: true }), z.coerce.date()]).transform((v) => new Date(v));

const cpdDetail = z.object({
  cpdCredits: z.coerce.number().min(0).max(999).optional(),
  accreditingBody: z.string().trim().max(160).optional(),
  learningObjectives: z.array(z.string().trim().max(500)).max(20).optional(),
  targetAudience: z.array(z.string().trim().max(200)).max(20).optional(),
  requirements: z.string().trim().max(5000).optional(),
}).optional();

const eventBody = z.object({
  title: z.string().trim().min(3).max(255),
  shortDescription: z.string().trim().max(500).optional(),
  description: z.string().trim().max(50_000).optional(),
  bannerFileId: z.coerce.number().int().positive().nullable().optional(),
  startAt: iso,
  endAt: iso,
  timezone: z.string().trim().max(64).default('Africa/Accra'),
  deliveryMode: z.enum(['ONLINE', 'OFFLINE', 'HYBRID']).default('OFFLINE'),
  countryCode: z.string().trim().length(2).toUpperCase().optional(),
  city: z.string().trim().max(120).optional(),
  venue: z.string().trim().max(255).optional(),
  onlineUrl: z.string().url().max(500).optional(),
  capacity: z.coerce.number().int().min(1).max(1_000_000).nullable().optional(),
  virtualCapacity: z.coerce.number().int().min(1).max(1_000_000).nullable().optional(),
  allowWaitlist: z.boolean().default(false),
  registrationOpensAt: iso.optional(),
  registrationClosesAt: iso.optional(),
  paymentHoldHours: z.coerce.number().int().min(1).max(720).nullable().optional(),
  issuesCertificate: z.boolean().default(false),
  certificateTemplateId: z.coerce.number().int().positive().nullable().optional(),
  certificateRequiresPayment: z.boolean().default(true),
  certificateRequiresEvaluation: z.boolean().default(false),
  attendanceRule: z.enum(['NONE', 'CHECK_IN', 'SESSION_PERCENT']).default('CHECK_IN'),
  minAttendancePercent: z.coerce.number().int().min(1).max(100).nullable().optional(),
  organizerDepartmentId: z.coerce.number().int().positive().nullable().optional(),
  contactEmail: z.string().email().max(190).optional(),
  contactPhone: z.string().trim().max(32).optional(),
  cpd: cpdDetail,
}).refine((d) => d.endAt >= d.startAt, {
  message: 'The event cannot end before it starts.',
  path: ['endAt'],
});

export const createEventSchema = eventBody;
export const updateEventSchema = eventBody.innerType().partial();

export const idParam = z.object({ id: z.coerce.number().int().positive() });
export const slugParam = z.object({ slug: z.string().trim().min(1).max(180) });

export const transitionSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const questionSchema = z.object({
  label: z.string().trim().min(1).max(255),
  helpText: z.string().trim().max(500).optional(),
  type: z.enum([
    'TEXT', 'LONGTEXT', 'NUMBER', 'EMAIL', 'PHONE',
    'SELECT', 'MULTISELECT', 'RADIO', 'CHECKBOX', 'DATE', 'FILE',
  ]),
  options: z.array(z.object({
    value: z.string().trim().min(1).max(120),
    label: z.string().trim().min(1).max(200),
  })).max(100).optional(),
  required: z.boolean().default(false),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
}).refine(
  (q) => !['SELECT', 'MULTISELECT', 'RADIO'].includes(q.type) || (q.options?.length ?? 0) > 0,
  { message: 'A choice question needs at least one option.', path: ['options'] },
);

export const questionsSchema = z.object({
  questions: z.array(questionSchema).max(60),
});

export const priceSchema = z.object({
  tier: z.string().trim().max(48).default('standard'),
  label: z.string().trim().min(1).max(120),
  attendanceMode: z.enum(['ANY', 'IN_PERSON', 'VIRTUAL']).default('ANY'),
  audience: z.enum(['ANY', 'HOST_COUNTRY', 'AFRICA', 'INTERNATIONAL']).default('ANY'),
  // The amount as written, e.g. "150.00". Converted to minor units server-side
  // against the currency's exponent — never multiplied by 100 in a client.
  amount: z.string().trim().regex(/^\d+(\.\d{1,4})?$/, 'Enter an amount such as 150.00'),
  currency: z.string().trim().length(3).toUpperCase(),
  priority: z.coerce.number().int().min(0).max(9999).default(100),
  isDefault: z.boolean().default(false),
  availableFrom: iso.optional(),
  availableUntil: iso.optional(),
});

export const pricesSchema = z.object({
  prices: z.array(priceSchema).min(1).max(40),
});

export const sessionSchema = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().trim().max(5000).optional(),
  startAt: iso,
  endAt: iso,
  location: z.string().trim().max(255).optional(),
  requiredForAttendance: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
});

export const sessionsSchema = z.object({
  sessions: z.array(sessionSchema).max(100),
});

export const speakerSchema = z.object({
  name: z.string().trim().min(1).max(160),
  title: z.string().trim().max(160).optional(),
  organization: z.string().trim().max(160).optional(),
  bio: z.string().trim().max(5000).optional(),
  role: z.enum(['SPEAKER', 'FACILITATOR', 'MODERATOR', 'PANELLIST']).default('SPEAKER'),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
});

export const speakersSchema = z.object({
  speakers: z.array(speakerSchema).max(100),
});

export const listEventsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.string().trim().max(64).optional(),
  order: z.enum(['asc', 'desc', 'ASC', 'DESC']).default('desc'),
  q: z.string().trim().max(200).optional(),
  status: z.string().trim().max(32).optional(),
  countryCode: z.string().trim().length(2).toUpperCase().optional(),
  from: iso.optional(),
  to: iso.optional(),
});

export default {
  createEventSchema, updateEventSchema, idParam, slugParam, transitionSchema,
  questionsSchema, pricesSchema, sessionsSchema, speakersSchema, listEventsSchema,
};
