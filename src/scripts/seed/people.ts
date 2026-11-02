import { randomUUID } from 'node:crypto';
import { provisionNewUser } from '../../modules/auth/provisioning.js';
import { hashPassword } from '../../modules/auth/password.js';
import { suspendUser } from '../../modules/admin/admin.users.service.js';
import type { AuditActor } from '../../modules/audit/audit.service.js';
import { adminVoidOpenBet } from '../../modules/bets/bets.service.js';
import { Bet } from '../../modules/bets/bet.model.js';
import { User, type UserRole } from '../../modules/users/user.model.js';
import { LedgerEntry } from '../../modules/wallet/ledger.model.js';
import { adminAdjust, claimDailyBonus } from '../../modules/wallet/wallet.service.js';

export interface SeedPassword {
  email: string;
  superadmin: string;
  shared: string;
}

export interface Person {
  id: string;
  email: string;
  name: string;
}

export interface People {
  superadmin: Person;
  actor: AuditActor;
  /** Superadmin first, then the admins. */
  staff: Person[];
  players: Person[];
  /** Backs results it somehow knows, so the risk screen has someone to flag. */
  sharp: Person;
  /** Every wallet starts with this on top of the welcome bonus. */
  startingCredit: number;
}

const DAY_MS = 24 * 3600 * 1000;
const STARTING_CREDIT = 20_000_00;
const JOINED_DAYS_AGO = 35;

const ADMINS = ['Asha Menon', 'Rohan Iyer'];
const PLAYERS = [
  'Aarav Sharma', 'Meera Pillai', 'Kabir Khan', 'Isha Verma', 'Vivaan Joshi', 'Ananya Rao', 'Arjun Nair', 'Diya Kapoor', 'Rehan Ali', 'Sara Thomas',
  'Nikhil Das', 'Tara Bose', 'Dev Malhotra', 'Pooja Reddy', 'Yash Patel', 'Neha Gupta', 'Imran Sheikh', 'Kiara Singh', 'Omar Farooq', 'Ritika Jain',
];

async function ensureStaff(name: string, email: string, role: UserRole, passwordHash: string): Promise<Person> {
  const existing = await User.findOne({ email }).lean();
  if (existing) return { id: existing._id.toString(), email, name: existing.name };
  const created = await User.create({ name, email, passwordHash, role, emailVerified: true });
  return { id: created._id.toString(), email, name };
}

async function ensurePlayer(name: string, email: string, passwordHash: string, actor: AuditActor): Promise<Person> {
  const existing = await User.findOne({ email }).lean();
  if (existing) return { id: existing._id.toString(), email, name };
  const user = await provisionNewUser({ name, email, passwordHash, emailVerified: true });
  const id = user._id.toString();
  await adminAdjust({ id: actor.id ?? '', role: actor.role, ip: null }, { targetUserId: id, direction: 'credit', amount: STARTING_CREDIT, reason: 'Demo starting balance', idempotencyKey: randomUUID() });
  // Joined weeks ago: the raw driver, because the ledger guard (rightly) refuses edits from app code.
  const joined = new Date(Date.now() - JOINED_DAYS_AGO * DAY_MS);
  await User.collection.updateOne({ _id: user._id }, { $set: { createdAt: joined } });
  await LedgerEntry.collection.updateMany({ userId: user._id }, { $set: { createdAt: joined } });
  return { id, email, name };
}

export async function seedPeople(secrets: SeedPassword): Promise<People> {
  const superHash = await hashPassword(secrets.superadmin);
  const sharedHash = await hashPassword(secrets.shared);
  const superadmin = await ensureStaff('Platform Owner', secrets.email.toLowerCase(), 'superadmin', superHash);
  const admins = await Promise.all(ADMINS.map((name, i) => ensureStaff(name, `admin${i + 1}@gamb.local`, 'admin', sharedHash)));
  const actor: AuditActor = { id: superadmin.id, role: 'superadmin', ip: null };
  const players: Person[] = [];
  for (const [i, name] of PLAYERS.entries()) players.push(await ensurePlayer(name, `demo${String(i + 1).padStart(2, '0')}@gamb.local`, sharedHash, actor));
  const sharp = players[6];
  if (!sharp) throw new Error('seed needs at least 7 players');
  return { superadmin, actor, staff: [superadmin, ...admins], players, sharp, startingCredit: STARTING_CREDIT };
}

/** A little day-to-day activity, so the audit log and user screens have something real in them. */
export async function seedOperations(people: People): Promise<void> {
  const [first, second, , , fifth] = people.players;
  if (!first || !second || !fifth) return;
  await claimDailyBonus(first.id);
  await claimDailyBonus(second.id);
  await adminAdjust({ id: people.actor.id ?? '', role: people.actor.role, ip: null }, { targetUserId: second.id, direction: 'credit', amount: 500_00, reason: 'Goodwill credit after a support ticket', idempotencyKey: randomUUID() });
  const open = await Bet.findOne({ status: 'ACCEPTED', userId: fifth.id }).lean();
  if (open) await adminVoidOpenBet(people.actor, open._id.toString(), 'Placed by mistake, confirmed with the player');
  const last = people.players.at(-1);
  if (last) await suspendUser(people.actor, last.id, 'Suspected multiple accounts, under review');
}
