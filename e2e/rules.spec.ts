import { expect, test } from '@playwright/test'
import { rawMail } from '../tests/fake-gmail'
import { launch, signIn, syncAndSettle, type Running } from './app'

let run: Running

test.afterEach(async () => run?.stop())

const earlier = (hours: number): Date => new Date(Date.now() - hours * 3_600_000)

test('a rule made in Settings: Apply now with Undo over the inbox, then new mail it holds for is labelled and archived as it lands', async () => {
  run = await launch()
  const { page, gmail } = run
  gmail.labels = ['Receipts']
  gmail.add(rawMail({ subject: 'Old receipt', from: 'Shop <orders@shop.example>' }), { arrived: earlier(3) })
  gmail.add(rawMail({ subject: 'Hello', from: 'Mai <mai@example.com>' }), { arrived: earlier(3) })
  await signIn(run)
  const list = page.locator('.threads')
  await expect(list.getByText('Old receipt')).toBeVisible()

  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Rules', exact: true }).click()
  await expect(settings.getByText('None', { exact: true })).toBeVisible()
  await settings.getByRole('button', { name: 'New rule' }).click()
  const editor = settings.getByRole('group', { name: 'New rule' })
  await expect(editor.getByRole('button', { name: 'Save' })).toBeDisabled() // nothing to look for yet
  await editor.getByLabel('Name').fill('Receipts')
  await editor.getByLabel('Condition 1, field').selectOption('Subject')
  await editor.getByLabel('Condition 1, test').selectOption('contains')
  await editor.getByLabel('Condition 1, value').fill('receipt')
  await editor.getByLabel('Action 1', { exact: true }).selectOption('Add label')
  await expect(editor.getByLabel('Action 1, label')).toHaveValue('Receipts')
  await editor.getByRole('button', { name: 'Add action' }).click()
  await expect(editor.getByLabel('Action 2', { exact: true })).toHaveValue('archive')
  await editor.getByRole('button', { name: 'Save' }).click()

  const row = settings.getByRole('group', { name: 'Receipts' })
  await expect(row.getByRole('checkbox', { name: 'Receipts' })).toBeChecked()
  await row.getByRole('button', { name: 'Apply Receipts now' }).click()
  const note = settings.getByRole('status')
  await expect(note).toContainText('1 labelled')
  await note.getByRole('button', { name: 'Undo' }).click()
  await expect(note).toHaveCount(0)
  await settings.getByRole('button', { name: 'Done' }).click()
  await expect(list.getByText('Old receipt')).toBeVisible()
  await page.waitForTimeout(7000) // past Undo's five seconds and the one more the change waits
  expect(gmail.writes().filter((c) => /X-GM-LABELS/.test(c))).toEqual([])

  // In batches, as a new profile is: filed away by a rule, it isn't held for one.
  gmail.add(rawMail({ subject: 'Your receipt', from: 'Shop <orders@shop.example>' }))
  await syncAndSettle(page)
  const arrived = (): string[] | undefined => gmail.mails.find((m) => m.raw.toString().includes('Your receipt'))?.labels
  await expect.poll(arrived, { timeout: 15_000 }).toEqual(['Receipts'])
  await expect(list.getByText('Your receipt')).toHaveCount(0)
  await page.locator('.sidebar').getByRole('button', { name: 'Receipts', exact: true }).click()
  await expect(list.getByText('Your receipt')).toBeVisible()
  await expect(list.getByText('Old receipt')).toHaveCount(0)

  // Off, it lets the next one by.
  await page.getByRole('button', { name: 'Settings' }).click()
  await settings.getByRole('button', { name: 'Rules', exact: true }).click()
  await row.getByRole('checkbox', { name: 'Receipts' }).uncheck()
  await expect(row.getByRole('checkbox', { name: 'Receipts' })).not.toBeChecked()
  await settings.getByRole('button', { name: 'Done' }).click()
  gmail.add(rawMail({ subject: 'Second receipt', from: 'Shop <orders@shop.example>' }))
  await syncAndSettle(page)
  await page.waitForTimeout(1000)
  expect(gmail.mails.find((m) => m.raw.toString().includes('Second receipt'))?.labels).toEqual(['\\Inbox'])
})

test('a rule is edited, moved and deleted in Settings, and a pattern that does not read is turned down', async () => {
  run = await launch()
  const { page } = run
  await signIn(run)
  for (const name of ['First', 'Second']) {
    await page.evaluate((named) => window.mail.saveRule({
      name: named, account: '', on: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: named.toLowerCase() }], actions: [{ kind: 'read' }]
    }), name)
  }
  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Rules', exact: true }).click()
  const names = settings.locator('.rule-row .check span')
  await expect(names).toHaveText(['First', 'Second'])
  await expect(settings.getByRole('button', { name: 'Move First up' })).toBeDisabled()
  await settings.getByRole('button', { name: 'Move Second up' }).click()
  await expect(names).toHaveText(['Second', 'First'])

  await settings.getByRole('button', { name: 'Edit First' }).click()
  const editor = settings.getByRole('group', { name: 'Edit rule' })
  await editor.getByLabel('Condition 1, test').selectOption('matches')
  await editor.getByLabel('Condition 1, value').fill('(first')
  await expect(editor.getByText("That pattern isn't valid.")).toBeVisible()
  await expect(editor.getByRole('button', { name: 'Save' })).toBeDisabled()
  await editor.getByLabel('Condition 1, value').fill('^first@')
  await editor.getByLabel('Name').fill('Renamed')
  await editor.getByRole('button', { name: 'Save' }).click()
  await expect(names).toHaveText(['Second', 'Renamed'])
  expect((await page.evaluate(() => window.mail.mailRules()))[1]?.conditions).toEqual([{ field: 'from', op: 'matches', value: '^first@' }])

  await settings.getByRole('button', { name: 'Edit Second' }).click()
  await settings.getByRole('group', { name: 'Edit rule' }).getByRole('button', { name: 'Delete' }).click()
  await page.locator('dialog.confirm', { hasText: 'Delete Second?' }).getByRole('button', { name: 'Delete' }).click()
  await expect(names).toHaveText(['Renamed'])
})
