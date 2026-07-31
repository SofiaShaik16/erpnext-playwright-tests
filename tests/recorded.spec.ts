import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://tpt-uat.frappe.cloud/login#login');
  await page.getByRole('textbox', { name: 'Email' }).click();
  await page.getByRole('textbox', { name: 'Email' }).fill('sofia.shaik@promantia.com');
  await page.getByRole('textbox', { name: 'Password' }).click();
  await page.getByRole('textbox', { name: 'Password' }).fill('suat@123');
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForURL(/\/apps|\/app/, { timeout: 30000 });
  await page.goto('/app');
  await page.getByRole('combobox', { name: /Search or type a command/ }).click();
  await page.getByRole('combobox', { name: /Search or type a command/ }).fill('item');
  await page.getByRole('link', { name: 'Item List', exact: true }).click();
  await page.getByRole('button', { name: 'Add Item' }).click();
  await page.getByLabel('Details').getByRole('combobox').filter({ hasText: /^$/ }).click();
  await page.getByText('Golf Parts').first().click();
  await page.locator('div').filter({ hasText: /^Golf Parts$/ }).click();
  await page.getByRole('textbox').first().click();
  await page.getByRole('textbox').first().fill('cable');
  await page.getByRole('tab', { name: 'Accounting' }).click();
  await page.getByRole('tabpanel', { name: 'Accounting' }).getByRole('combobox').selectOption('Raw Material (RM)');
  await page.getByRole('button', { name: 'Save' }).click();
});