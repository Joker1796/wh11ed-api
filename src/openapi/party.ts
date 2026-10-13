import { z } from 'zod'
import {
  createBodySchema, inviteTokenSchema, joinBodySchema, memberIdSchema, memberTokenSchema, partyIdSchema, reclaimBodySchema,
  seatBodySchema, SLICE_NAMES, syncBodySchema,
} from '../domain/party.js'
import { hostSeatSchema, inviteBodySchema, transferSchema } from '../routes/party.js'
import { asAccount, asMember, body, describe, errorSchema, registry, unauthorized } from './registry.js'

// /party — one live game shared by several phones (routes/party.ts, domain/party.ts, README "A
// shared live game"). The host's account creates a party and can reclaim it; after that every
// phone, the host's included, speaks with its own member token. /party/join is the one public door.

const tags = ['Party']
const hostTags = ['Party: host']
const params = z.object({ id: partyIdSchema })

// ── What the answers are made of ───────────────────────────────────────────────────────────────

const side = z.union([z.literal(0), z.literal(1)]).nullable()
const you = z.object({ memberId: memberIdSchema, side, mi: side, host: z.boolean() }).openapi('PartyYou', {
  description: 'This phone: its seat (`side` 0/1 and, in doubles, `mi` 0/1; null = not seated) and whether it is the host',
})
const member = z
  .object({ memberId: memberIdSchema, name: z.string(), side, mi: side, host: z.boolean(), lastSeenAt: z.string().nullable(), you: z.boolean() })
  .openapi('PartyMember')
const slices = z
  .object(Object.fromEntries(SLICE_NAMES.map((n) => [n, z.object({ version: z.number(), data: z.unknown() }).optional()])))
  .openapi('PartySlices', { description: 'Slices by name, each with the version it is at; the data is the tracker’s' })
const status = z.enum(['open', 'finished'])
const held = z.array(z.number()).openapi({ description: 'The sides some OTHER live phone sits on' })
const seq = z.number().openapi({ description: 'The party’s change counter: send it back as `since`' })
const invite = z.object({ token: inviteTokenSchema.nullable(), code: z.string().nullable(), codeExpiresAt: z.string().nullable() }).openapi('PartyInvite', {
  description: '`token` goes in the link / QR; `code` is six digits to type across the table and lives minutes',
})
const heldBy = z.object({ error: z.literal('seat_taken'), heldBy: z.object({ name: z.string(), lastSeenAt: z.string().nullable() }) })
const trackerVersion = z.object({ error: z.literal('tracker_version'), gen: z.number() }).openapi({
  description: 'The party is played on the other tracker; `gen` says which',
})
const fullState = { seq, status, slices, members: z.array(member) }

registry.register('PartyCreate', createBodySchema)
registry.register('PartySync', syncBodySchema)

// Every member route answers these when its token does not hold.
const memberRefusals = {
  400: { description: 'Bad party id', schema: errorSchema('bad_id') },
  401: { description: 'No member token, an unknown one, or this phone was removed', schema: errorSchema('missing_member_token', 'invalid_member_token', 'revoked') },
  403: { description: 'The token belongs to another party', schema: errorSchema('wrong_party') },
}
const hostRefusals = {
  ...memberRefusals,
  403: { description: 'Not the host, or the token belongs to another party', schema: errorSchema('host_only', 'wrong_party') },
}
const notFound = { 404: { description: 'No such party or member', schema: errorSchema('not_found') } }
const notJson = { 400: { description: 'Bad party id, or the body is not JSON', schema: errorSchema('bad_id', 'invalid_json') } }

// ── With the host's account ────────────────────────────────────────────────────────────────────

describe({
  method: 'post',
  path: '/party',
  tags,
  summary: 'Start a shared game — the host, with an account',
  description: 'Every slice is sent at version 0. The answer carries the host phone’s member token and the invite.',
  security: asAccount,
  request: { body: body(createBodySchema) },
  responses: {
    201: {
      description: 'Created',
      schema: z.object({
        partyId: partyIdSchema,
        memberId: memberIdSchema,
        memberToken: memberTokenSchema,
        seq,
        status: z.literal('open'),
        versions: z.record(z.string(), z.number()),
        you,
        invite: invite.extend({ token: inviteTokenSchema, code: z.string(), codeExpiresAt: z.string() }),
      }),
    },
    400: { description: 'Not JSON', schema: errorSchema('invalid_json') },
    413: { description: 'A slice is over its size cap', schema: errorSchema('payload_too_large') },
    422: { description: 'Not a party', schema: errorSchema('invalid_party') },
    ...unauthorized,
  },
})

const joined = z.object({ partyId: partyIdSchema, memberId: memberIdSchema, memberToken: memberTokenSchema, ...fullState, you })

describe({
  method: 'post',
  path: '/party/{id}/reclaim',
  tags: hostTags,
  summary: 'The host taking the party back on another phone — with the account',
  description: 'A new member token for the host; the old phone’s stops working.',
  security: asAccount,
  request: { params, body: body(reclaimBodySchema, false) },
  responses: {
    200: { description: 'Reclaimed', schema: joined },
    400: { description: 'Bad party id', schema: errorSchema('bad_id') },
    404: { description: 'No such party, or not this account’s', schema: errorSchema('not_found') },
    409: { description: 'Another tracker', schema: trackerVersion },
    ...unauthorized,
  },
})

// ── Public: the invite is the credential ───────────────────────────────────────────────────────

describe({
  method: 'post',
  path: '/party/join',
  tags,
  summary: 'Join by the link’s token or the six-digit code',
  description: 'No account. Send `gen` (the tracker generation) so a phone of the other tracker is turned away before it takes a place.',
  request: { body: body(joinBodySchema) },
  responses: {
    201: { description: 'Joined, not seated yet', schema: joined },
    400: { description: 'Not JSON', schema: errorSchema('invalid_json') },
    404: { description: 'No such invite, or the code expired', schema: errorSchema('not_found') },
    409: { description: 'Two live parties share the code, or another tracker', schema: z.union([errorSchema('ambiguous_code'), trackerVersion]) },
    422: { description: 'Neither a code nor an invite', schema: errorSchema('invalid_invite') },
  },
})

// ── Every phone, with its member token ─────────────────────────────────────────────────────────

describe({
  method: 'get',
  path: '/party/{id}',
  tags,
  summary: 'The whole game — what a phone rebuilds from',
  security: asMember,
  request: { params },
  responses: { 200: { description: 'The state', schema: z.object({ ...fullState, held, you }) }, ...memberRefusals, ...notFound },
})

describe({
  method: 'get',
  path: '/party/{id}/members',
  tags,
  summary: 'Who is in the party',
  security: asMember,
  request: { params },
  responses: { 200: { description: 'Live members', schema: z.object({ members: z.array(member) }) }, ...memberRefusals },
})

describe({
  method: 'post',
  path: '/party/{id}/seat',
  tags,
  summary: 'Take a seat',
  description: 'A phone may always retake its own seat; one another phone holds is refused with who holds it.',
  security: asMember,
  request: { params, body: body(seatBodySchema) },
  responses: {
    200: { description: 'Seated', schema: z.object({ seq, you }) },
    ...memberRefusals,
    ...notJson,
    409: { description: 'Another phone holds the seat', schema: heldBy },
    422: { description: 'Not a seat', schema: errorSchema('invalid_seat') },
  },
})

describe({
  method: 'post',
  path: '/party/{id}/leave',
  tags,
  summary: 'A guest leaving — its token dies, its seat is free',
  security: asMember,
  request: { params },
  responses: { 204: 'Left', ...memberRefusals, 422: { description: 'The host cannot leave: end the party or hand it over', schema: errorSchema('host_cannot_leave') } },
})

const conflictState = { seq, status, you, held, slices }

describe({
  method: 'post',
  path: '/party/{id}/sync',
  tags,
  summary: 'Send what changed here, get what changed elsewhere — one request',
  description:
    'Each written slice carries the version it was edited from; one stale slice refuses the whole batch with 409 and the current state. 204 when nothing happened since `since` and nothing was sent.',
  security: asMember,
  request: { params, body: body(syncBodySchema) },
  responses: {
    200: {
      description: 'What other phones changed since `since`, and the versions this phone’s writes landed at',
      schema: z.object({ seq, status, you, held, written: z.record(z.string(), z.number()), slices }),
    },
    204: 'Nothing new, nothing sent',
    ...memberRefusals,
    ...notJson,
    403: {
      description: 'A slice this seat may not write, or the token belongs to another party',
      schema: z.union([z.object({ error: z.literal('forbidden_slice'), slices: z.array(z.enum(SLICE_NAMES)) }), errorSchema('wrong_party')]),
    },
    ...notFound,
    409: { description: 'A slice was edited from an old version: take these and carry on', schema: z.object({ error: z.literal('version_conflict'), stale: z.array(z.enum(SLICE_NAMES)), ...conflictState }) },
    413: { description: 'A slice is over its size cap', schema: errorSchema('payload_too_large') },
    422: { description: 'Not a sync, or an unknown slice', schema: errorSchema('invalid_sync', 'unknown_slice') },
    423: { description: 'The game is finished: read-only for guests', schema: z.object({ error: z.literal('read_only'), ...conflictState, status: z.literal('finished') }) },
  },
})

// ── The host ───────────────────────────────────────────────────────────────────────────────────

describe({
  method: 'get',
  path: '/party/{id}/invite',
  tags: hostTags,
  summary: 'The invite — the code only while it lives',
  security: asMember,
  request: { params },
  responses: { 200: { description: 'The invite', schema: invite }, ...hostRefusals, ...notFound },
})

describe({
  method: 'post',
  path: '/party/{id}/invite',
  tags: hostTags,
  summary: 'A fresh code — and with `link: true` a fresh link (the old one stops working)',
  security: asMember,
  request: { params, body: body(inviteBodySchema, false) },
  responses: {
    200: { description: 'The new invite', schema: invite.extend({ code: z.string(), codeExpiresAt: z.string() }) },
    ...hostRefusals,
    422: { description: 'Not an invite request', schema: errorSchema('invalid_invite') },
  },
})

const mid = z.object({ id: partyIdSchema, mid: memberIdSchema })

describe({
  method: 'post',
  path: '/party/{id}/members/{mid}/seat',
  tags: hostTags,
  summary: 'Move another phone to a seat, or clear its seat (`side: null`)',
  security: asMember,
  request: { params: mid, body: body(hostSeatSchema) },
  responses: {
    200: { description: 'Moved', schema: z.object({ seq }) },
    ...hostRefusals,
    ...notJson,
    ...notFound,
    409: { description: 'Another phone holds that seat', schema: heldBy },
    422: { description: 'Not a seat', schema: errorSchema('invalid_seat') },
  },
})

describe({
  method: 'post',
  path: '/party/{id}/members/{mid}/kick',
  tags: hostTags,
  summary: 'Remove a phone — its token dies, its seat is free',
  security: asMember,
  request: { params: mid },
  responses: {
    200: { description: 'Removed', schema: z.object({ seq }) },
    ...hostRefusals,
    ...notFound,
    422: { description: 'The host cannot remove itself', schema: errorSchema('not_self') },
  },
})

describe({
  method: 'post',
  path: '/party/{id}/reseat',
  tags: hostTags,
  summary: 'Swap the two sides across every seat — settling who goes first',
  description: 'The slices follow in the host’s next sync.',
  security: asMember,
  request: { params },
  responses: { 200: { description: 'Swapped', schema: z.object({ seq, you: you.nullable(), held }) }, ...hostRefusals },
})

describe({
  method: 'post',
  path: '/party/{id}/host',
  tags: hostTags,
  summary: 'Hand the host role to another phone',
  description: 'Reclaiming with the account stays with the party’s creator.',
  security: asMember,
  request: { params, body: body(transferSchema) },
  responses: {
    200: { description: 'Handed over', schema: z.object({ seq }) },
    ...hostRefusals,
    ...notJson,
    ...notFound,
    422: { description: 'Not a member id, or this phone itself', schema: errorSchema('invalid_member', 'not_self') },
  },
})

describe({
  method: 'delete',
  path: '/party/{id}',
  tags: hostTags,
  summary: 'End the party — every token goes with it',
  description: 'The game itself stays in each phone’s tracker.',
  security: asMember,
  request: { params },
  responses: { 204: 'Ended', ...hostRefusals },
})
