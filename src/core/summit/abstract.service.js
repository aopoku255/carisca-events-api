import { models, sequelize } from '../../database/models/index.js';
import { registrationReference } from '../../lib/ids.js';
import {
  ConflictError, NotFoundError, ValidationError,
} from '../../lib/errors.js';
import { record as audit } from '../audit/audit.service.js';
import { notify } from '../notifications/notification.service.js';

const {
  AbstractSubmission, Event, SummitEventDetail, EventTrack, File, User,
} = models;

/**
 * A researcher's proposal to present at a Summit.
 *
 * The status machine is small enough to live here as plain checks rather
 * than through the generic event state machine, which exists for a
 * different domain (an event's own lifecycle) with different actors.
 *
 *   SUBMITTED -> UNDER_REVIEW -> ACCEPTED | REJECTED   (terminal)
 *            \-> WITHDRAWN                              (terminal)
 *
 * WITHDRAWN is reachable from SUBMITTED or UNDER_REVIEW only — never from a
 * decision that has already been made.
 */
const EDITABLE_STATUSES = ['SUBMITTED', 'UNDER_REVIEW'];

const INCLUDE = [
  { model: Event, as: 'event', include: [{ model: SummitEventDetail, as: 'summit' }] },
  { model: EventTrack, as: 'track' },
  { model: File, as: 'paper' },
  { model: User, as: 'author' },
  { model: User, as: 'decidedBy' },
];

export async function findById(id) {
  const submission = await AbstractSubmission.findByPk(id, { include: INCLUDE });
  if (!submission) throw new NotFoundError('Submission');
  return submission;
}

export async function findByReference(reference) {
  const submission = await AbstractSubmission.findOne({ where: { reference }, include: INCLUDE });
  if (!submission) throw new NotFoundError('Submission');
  return submission;
}

function assertOwned(submission, userId) {
  if (String(submission.user_id) !== String(userId)) throw new NotFoundError('Submission');
}

/**
 * Refuses a submission once the call for papers has closed, if the event set
 * a deadline — an event with no deadline accepts submissions for as long as
 * it stays open.
 */
async function assertCallOpen(event) {
  const closesAt = event.summit?.call_for_papers_closes_at;
  if (closesAt && new Date(closesAt) < new Date()) {
    throw new ConflictError(
      'The call for papers for this event has closed.',
      'CALL_FOR_PAPERS_CLOSED',
    );
  }
}

export async function submit(input, { user, context = {} }) {
  const event = await Event.findByPk(input.eventId, {
    include: [
      { model: SummitEventDetail, as: 'summit' },
      { model: models.EventType, as: 'type' },
    ],
  });
  if (!event || event.type?.key !== 'summit') throw new NotFoundError('Event');
  await assertCallOpen(event);

  const submission = await sequelize.transaction(async (transaction) => {
    const created = await AbstractSubmission.create({
      event_id: event.id,
      user_id: user.id,
      reference: registrationReference('ABS'),
      title: input.title,
      abstract_text: input.abstractText,
      track_id: input.trackId ?? null,
      co_authors: input.coAuthors ?? null,
      paper_file_id: input.paperFileId ?? null,
      status: 'SUBMITTED',
      submitted_at: new Date(),
    }, { transaction });

    await audit({
      actor: { id: user.id, email: user.email },
      action: 'abstract.submitted',
      resourceType: 'abstract_submission',
      resourceId: created.id,
      after: { title: created.title, eventId: String(event.id) },
      context,
    }, { transaction });

    return created;
  });

  return findById(submission.id);
}

export async function update(id, input, { user, context = {} }) {
  const submission = await findById(id);
  assertOwned(submission, user.id);

  if (!EDITABLE_STATUSES.includes(submission.status)) {
    throw new ConflictError(
      `A submission cannot be edited once it is ${submission.status.toLowerCase().replace('_', ' ')}.`,
      'SUBMISSION_NOT_EDITABLE',
    );
  }

  const before = submission.toJSON();

  await sequelize.transaction(async (transaction) => {
    await submission.update({
      title: input.title ?? submission.title,
      abstract_text: input.abstractText ?? submission.abstract_text,
      track_id: input.trackId !== undefined ? input.trackId : submission.track_id,
      co_authors: input.coAuthors !== undefined ? input.coAuthors : submission.co_authors,
      paper_file_id: input.paperFileId !== undefined ? input.paperFileId : submission.paper_file_id,
    }, { transaction });

    await audit({
      actor: { id: user.id, email: user.email },
      action: 'abstract.updated',
      resourceType: 'abstract_submission',
      resourceId: id,
      before: { title: before.title },
      after: { title: submission.title },
      context,
    }, { transaction });
  });

  return findById(id);
}

export async function withdraw(id, { user, context = {} }) {
  const submission = await findById(id);
  assertOwned(submission, user.id);

  if (!EDITABLE_STATUSES.includes(submission.status)) {
    throw new ConflictError(
      `A submission cannot be withdrawn once it is ${submission.status.toLowerCase().replace('_', ' ')}.`,
      'SUBMISSION_NOT_EDITABLE',
    );
  }

  await sequelize.transaction(async (transaction) => {
    await submission.update({ status: 'WITHDRAWN' }, { transaction });
    await audit({
      actor: { id: user.id, email: user.email },
      action: 'abstract.withdrawn',
      resourceType: 'abstract_submission',
      resourceId: id,
      context,
    }, { transaction });
  });

  return findById(id);
}

export async function claim(id, { actor, notes, context = {} }) {
  const submission = await findById(id);

  if (!EDITABLE_STATUSES.includes(submission.status)) {
    throw new ConflictError(
      `A decided submission cannot be reclaimed for review.`,
      'SUBMISSION_ALREADY_DECIDED',
    );
  }

  await sequelize.transaction(async (transaction) => {
    await submission.update({
      status: 'UNDER_REVIEW',
      review_notes: notes !== undefined ? notes : submission.review_notes,
    }, { transaction });
    await audit({
      actor,
      action: 'abstract.claimed',
      resourceType: 'abstract_submission',
      resourceId: id,
      context,
    }, { transaction });
  });

  return findById(id);
}

export async function decide(id, { actor, decision, notes, context = {} }) {
  if (!['ACCEPTED', 'REJECTED'].includes(decision)) {
    throw new ValidationError([{ field: 'decision', message: 'Decision must be ACCEPTED or REJECTED.' }]);
  }

  const submission = await findById(id);
  if (!EDITABLE_STATUSES.includes(submission.status)) {
    throw new ConflictError('This submission already has a decision.', 'SUBMISSION_ALREADY_DECIDED');
  }

  await sequelize.transaction(async (transaction) => {
    await submission.update({
      status: decision,
      review_notes: notes !== undefined ? notes : submission.review_notes,
      decided_by: actor.id,
      decided_at: new Date(),
    }, { transaction });

    await audit({
      actor,
      action: 'abstract.decided',
      resourceType: 'abstract_submission',
      resourceId: id,
      after: { decision },
      context,
    }, { transaction });
  });

  const decided = await findById(id);

  await notify({
    userId: decided.user_id,
    channel: 'EMAIL',
    template: 'abstract_decided',
    toAddress: decided.author?.email,
    subject: `${decision === 'ACCEPTED' ? 'Accepted' : 'Update'}: ${decided.title}`,
    payload: {
      firstName: decided.author?.first_name,
      title: decided.title,
      eventTitle: decided.event?.title,
      accepted: decision === 'ACCEPTED',
      notes: notes ?? null,
    },
    resourceType: 'abstract_submission',
    resourceId: String(id),
  });

  return decided;
}

export default {
  findById, findByReference, submit, update, withdraw, claim, decide,
};
