import { PermissionResource } from '@/shared/enums';

/**
 * How the permission list is presented to somebody building a role.
 *
 * WHY THIS IS NOT JUST THE ENUM. A role editor showing twenty-nine codes in
 * alphabetical order is a list nobody reads, and the person using it is an
 * office manager rather than an engineer. `comments.hide` means nothing;
 * "Comments → Hide a comment" means something. The grouping is by resource
 * because that is how people think about the job — everything about mentions
 * together, everything about the team together.
 *
 * The ORDER is the reading order, not the enum order: the things a business
 * touches daily come first, and the things it configures once come last. An
 * alphabetical list would put `channels` above `conversations`, which buries
 * the inbox under the plumbing.
 *
 * The DESCRIPTIONS of individual permissions live in the database, written by
 * the seed, because they are data a client can read without a release. Only the
 * grouping lives here, because it is presentation and changes with the screen.
 */
export interface PermissionGroup {
  readonly label: string;
  readonly description: string;
  /** Lower comes first. */
  readonly order: number;
}

export const PERMISSION_GROUPS: Readonly<Record<PermissionResource, PermissionGroup>> = {
  [PermissionResource.Conversations]: {
    label: 'Direct messages',
    description: 'Private conversations with customers, on Messenger and Instagram.',
    order: 10,
  },
  [PermissionResource.Comments]: {
    label: 'Comments',
    description: 'Comment threads under the posts this business owns.',
    order: 20,
  },
  [PermissionResource.Mentions]: {
    label: 'Mentions',
    description: 'Posts and stories where somebody else has tagged this business.',
    order: 30,
  },
  [PermissionResource.Posts]: {
    label: 'Posts',
    description: 'Published posts and how they performed.',
    order: 40,
  },
  [PermissionResource.Customers]: {
    label: 'Customers',
    description: 'The directory of people this business has talked to.',
    order: 50,
  },
  [PermissionResource.Channels]: {
    label: 'Connected accounts',
    description: 'The Facebook Pages and Instagram accounts this business has connected.',
    order: 60,
  },
  [PermissionResource.Employees]: {
    label: 'Team',
    description: 'The people who work here, and their invitations.',
    order: 70,
  },
  [PermissionResource.Roles]: {
    label: 'Roles and access',
    description: 'What each person is allowed to do. Handle with care.',
    order: 80,
  },
  [PermissionResource.Features]: {
    label: 'Features',
    description: 'Which parts of the product this business has.',
    order: 90,
  },
  [PermissionResource.Enterprise]: {
    label: 'Business settings',
    description: 'Company details and billing.',
    order: 100,
  },
};

/** The resource half of a `<resource>.<action>` code, or null if it is not one. */
export function resourceOf(code: string): PermissionResource | null {
  const resource = code.split('.')[0];
  return resource && resource in PERMISSION_GROUPS ? (resource as PermissionResource) : null;
}
