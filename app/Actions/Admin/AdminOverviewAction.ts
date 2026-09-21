// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// The admin dashboard's data source.
//
// Authorisation is enforced HERE, not in the page. A client-side check only
// decides what to draw; anyone can skip it by calling the endpoint directly.
// So this action resolves the caller from their session, confirms the `admin`
// role, and refuses otherwise - the page's own gate is a courtesy on top.

/** Roles allowed to see the dashboard. */
import { Auth } from '@stacksjs/auth'
import { countOf } from './admin-overview-support'

const ADMIN_ROLES = ['admin']

/**
 * The signed-in user's role names.
 *
 * RBAC reads through a store the HTTP layer configures on boot. Installing it
 * lazily here keeps this action working in contexts that never ran that boot
 * (the CLI, a test harness) instead of throwing "RBAC store not configured".
 */
async function roleNamesFor(userId: number): Promise<string[]> {
  try {
    const { createBqbRbacStore, Rbac } = await import('@stacksjs/auth')
    Rbac.setStore(createBqbRbacStore())
    const roles = await Rbac.getUserRoles(userId)
    return (roles ?? []).map((role: any) => String(role?.name ?? '')).filter(Boolean)
  }
  catch {
    return []
  }
}

interface RoleAssignmentRow {
  role: string
  user_id: number
}

/**
 * Load every application role assignment in one query.
 *
 * The dashboard only renders the 25 newest accounts, but its totals describe
 * the whole application. Deriving the admin count from that visible slice
 * understated the real number as soon as an older account held the role.
 */
async function roleAssignments(): Promise<RoleAssignmentRow[]> {
  const rows = await db.sql`
    SELECT ur.user_id AS user_id, r.name AS role
    FROM user_roles ur
    INNER JOIN roles r ON r.id = ur.role_id
    WHERE r.guard_name = 'web'
  `.execute() as RoleAssignmentRow[]

  return Array.isArray(rows) ? rows : []
}

export default new Action({
  name: 'Admin Overview',
  description: 'Counts, recent accounts and their roles for the admin dashboard',
  method: 'GET',

  async handle() {
    const user = await Auth.user().catch(() => null)
    if (!user)
      return response.json({ success: false, error: 'Sign in to continue.' }, 401)

    const roles = await roleNamesFor(user.id)
    if (!roles.some(role => ADMIN_ROLES.includes(role))) {
      // Deliberately the same shape as any other refusal: an account that is
      // not an admin learns nothing about what the dashboard contains.
      return response.json({ success: false, error: 'This area is for administrators.' }, 403)
    }

    const [users, trails, activities, assignments] = await Promise.all([
      User.all().catch(() => []),
      countOf(Trail),
      countOf(Activity),
      roleAssignments(),
    ])

    const allAccounts = Array.isArray(users) ? users : []
    const rolesByUser = new Map<number, string[]>()
    for (const assignment of assignments) {
      const userId = Number(assignment.user_id)
      const roles = rolesByUser.get(userId) ?? []
      const role = String(assignment.role || '')
      if (role && !roles.includes(role))
        roles.push(role)
      rolesByUser.set(userId, roles)
    }

    const accounts = allAccounts
      .slice()
      .sort((a: any, b: any) => Number(b?.id ?? 0) - Number(a?.id ?? 0))
      .slice(0, 25)

    const accountRoles = accounts.map((account: any) => ({
        id: account.id,
        name: account.name ?? null,
        email: account.email,
        created_at: account.created_at ?? null,
        roles: rolesByUser.get(Number(account.id)) ?? [],
      }))

    const roleCounts = allAccounts.reduce((summary, account: any) => {
      const roles = rolesByUser.get(Number(account.id)) ?? []
      if (roles.includes('admin')) summary.admins += 1
      if (roles.includes('client')) summary.clients += 1
      if (roles.includes('paid')) summary.paid += 1
      if (roles.length === 0) summary.unassigned += 1
      return summary
    }, { admins: 0, clients: 0, paid: 0, unassigned: 0 })

    return response.json({
      success: true,
      viewer: { id: user.id, email: user.email, name: user.name ?? null, roles },
      counts: {
        users: allAccounts.length,
        trails,
        activities,
        ...roleCounts,
      },
      accounts: accountRoles,
      accountLimit: 25,
    })
  },
})
