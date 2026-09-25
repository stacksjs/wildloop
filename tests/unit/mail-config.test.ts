import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'

function mailConfig(env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ['--no-env-file', '-e', `
    import email from './config/email.ts'
    import services from './config/services.ts'
    console.log(JSON.stringify({
      from: email.from,
      domain: email.domain,
      server: { attachTo: email.server.attachTo, mode: email.server.mode },
      smtp: services.smtp,
    }))
  `], { cwd: resolve(import.meta.dir, '../..'), env, encoding: 'utf8' })
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout)
}

describe('mail configuration', () => {
  it('shares the Stacks mail server without adopting another app domain', () => {
    const config = mailConfig()
    expect(config.server).toEqual({ attachTo: 'stacks', mode: 'server' })
    expect(config.domain).toBe('wildloop.org')
    expect(config.from.address).toBe('no-reply@wildloop.org')
  })

  it('supports an authorized SMTP sender without changing mailbox ownership', () => {
    const config = mailConfig({
      MAIL_HOST: 'mail.stacksjs.com',
      MAIL_PORT: '587',
      MAIL_ENCRYPTION: 'tls',
      MAIL_USERNAME: 'noreply@bughq.org',
      MAIL_PASSWORD: 'test-only-not-a-real-password',
      MAIL_FROM_ADDRESS: 'noreply@bughq.org',
      MAIL_FROM_NAME: 'Wildloop',
    })
    expect(config.from).toEqual({ name: 'Wildloop', address: 'noreply@bughq.org' })
    expect(config.domain).toBe('wildloop.org')
    expect(config.smtp).toMatchObject({
      host: 'mail.stacksjs.com',
      port: 587,
      encryption: 'tls',
      username: 'noreply@bughq.org',
      password: 'test-only-not-a-real-password',
    })
  })
})
