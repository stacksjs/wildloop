import { expect, test } from '@playwright/test'
import { QA_PORTS } from './qa-ports'
import { QA_SOCIAL_ACCOUNT } from './qa-social-account'

/**
 * An account Google or Apple made has no password of its own, and Settings
 * must not ask it for one: the Password card offers to set one by email, and
 * Delete account asks for DELETE instead. App Review signs in with Apple and
 * deletes the account, so this is the path it takes.
 *
 * The seeded account (scripts/start-recording-qa.ts) is deleted at the end,
 * so this runs once per QA stack: the stack starts on a fresh database.
 */

const origin = `http://127.0.0.1:${QA_PORTS.proxy}`

test.use({ viewport: { width: 1280, height: 900 } })

test('an account Google made changes no password and deletes itself by typing DELETE', async ({ page }) => {
  // Stands in for coming back from Google: see qa-social-account.ts.
  await page.goto(`${origin}/login`)
  await page.locator('#email').fill(QA_SOCIAL_ACCOUNT.email)
  await page.locator('#password').fill(QA_SOCIAL_ACCOUNT.sessionSecret)
  const signedIn = page.waitForResponse(r => r.url().endsWith('/api/login') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Sign In', exact: true }).click()
  expect((await signedIn).ok()).toBeTruthy()
  await expect(page).not.toHaveURL(/\/login/)

  await page.goto(`${origin}/settings`)

  const passwordCard = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Password', exact: true }) })
  await expect(passwordCard.getByText('there is no password to change')).toBeVisible()
  await expect(passwordCard.getByLabel('Current password')).toHaveCount(0)
  await expect(passwordCard.getByRole('button', { name: 'Change password' })).toHaveCount(0)

  const deleteCard = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Delete account', exact: true }) })
  await deleteCard.getByRole('button', { name: 'Delete my account…' }).click()
  await expect(deleteCard.getByLabel('Enter your password to confirm')).toHaveCount(0)
  const confirmation = deleteCard.getByLabel('Type DELETE to confirm')
  await expect(confirmation).toBeVisible()

  // Anything but DELETE is refused before a request is made.
  await confirmation.fill('delete it')
  await deleteCard.getByRole('button', { name: 'Delete my account permanently' }).click()
  await expect(deleteCard.getByRole('alert')).toHaveText('Type DELETE to confirm.')

  await confirmation.fill('DELETE')
  const deleted = page.waitForResponse(r => r.url().endsWith('/api/me') && r.request().method() === 'DELETE')
  await deleteCard.getByRole('button', { name: 'Delete my account permanently' }).click()
  expect((await deleted).status()).toBe(204)

  // The account is gone: its session no longer reaches /api/me.
  const me = await page.request.get(`${origin}/api/me`)
  expect(me.status()).toBe(401)
})

test('an account with a password still changes it, and is asked for it to delete', async ({ page }) => {
  const password = `Local-QA-${crypto.randomUUID()}`
  await page.goto(`${origin}/register`)
  const form = page.locator('form').filter({ has: page.locator('#name') })
  await form.getByLabel('Full Name', { exact: true }).fill('Password QA')
  await form.getByLabel('Email', { exact: true }).fill(`password-${crypto.randomUUID()}@example.test`)
  await form.getByLabel('Password', { exact: true }).fill(password)
  await form.getByLabel('Confirm Password', { exact: true }).fill(password)
  await page.locator('#terms').check()
  const registered = page.waitForResponse(r => r.url().endsWith('/api/register') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Create Account', exact: true }).click()
  expect((await registered).ok()).toBeTruthy()

  await page.goto(`${origin}/settings`)

  const passwordCard = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Password', exact: true }) })
  await expect(passwordCard.getByLabel('Current password')).toBeVisible()
  await expect(passwordCard.getByRole('button', { name: 'Change password' })).toBeVisible()
  await expect(passwordCard.getByText('there is no password to change')).toHaveCount(0)

  const deleteCard = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Delete account', exact: true }) })
  await deleteCard.getByRole('button', { name: 'Delete my account…' }).click()
  await expect(deleteCard.getByLabel('Enter your password to confirm')).toBeVisible()
  await expect(deleteCard.getByLabel('Type DELETE to confirm')).toHaveCount(0)
})
