import { avataxRequest, connectionError, getSettings, missingSettings } from './lib/avatax';

export const config: SwellConfig = {
  description: 'Check the AvaTax credentials and company code',
  action: true,
};

// a thrown 400 shows in the admin as a red error popup, a returned message as a regular one
function fail(message: string): never {
  throw new SwellError(message, { status: 400 });
}

// works before AvaTax is selected in Settings → Taxes, so the credentials can be checked first
export default async function (req: SwellRequest) {
  const settings = getSettings(await req.swell.settings());

  const missing = missingSettings(settings);
  if (missing.length) {
    fail(`Add the ${missing.join(', ')} and save the settings first.`);
  }

  const environment = settings.environment === 'production' ? 'Production' : 'Sandbox';
  let company: any;
  try {
    // ping answers 200 with authenticated: false when the credentials are wrong
    const ping = await avataxRequest(settings, 'GET', '/utilities/ping');
    if (!ping?.authenticated) {
      fail(
        `AvaTax (${environment}) didn't accept the account ID or license key. Check them, and that the Environment matches the account.`,
      );
    }
    const filter = `companyCode eq '${settings.company_code.replace(/'/g, "''")}'`;
    const companies = await avataxRequest(settings, 'GET', `/companies?$filter=${encodeURIComponent(filter)}`);
    company = Array.isArray(companies?.value) ? companies.value[0] : undefined;
  } catch (err) {
    if (err instanceof SwellError) throw err;
    fail(connectionError(err));
  }

  if (!company) {
    fail(`Connected to AvaTax (${environment}), but this account has no company with the code ${settings.company_code}.`);
  }
  if (company.isActive === false) {
    fail(`Connected to AvaTax (${environment}), but the company ${settings.company_code} is not active.`);
  }

  const companyName = String(company.name || settings.company_code);
  const notes = [`Connected to AvaTax (${environment}), company ${companyName}${companyName.endsWith('.') ? '' : '.'}`];
  if (await builtInAvaTaxConnected(req)) {
    notes.push(
      "Swell's built-in Avalara AvaTax integration is also connected and records orders in AvaTax with the same document codes. Disconnect it in Settings → Integrations, so sales aren't overwritten or recorded twice.",
    );
  }
  if (!settings.record_sales) {
    notes.push('Recording sales is off, so paid orders are not sent to AvaTax for filing.');
  }
  return { message: notes.join(' ') };
}

// Swell's own AvaTax integration (Settings → Integrations), when enabled, keeps recording orders while the app calculates taxes
async function builtInAvaTaxConnected(req: SwellRequest): Promise<boolean> {
  try {
    const integrations = await req.swell.get('/settings/integrations');
    return integrations?.services?.avatax?.enabled === true;
  } catch {
    // the warning is optional; the connection check above already passed
    return false;
  }
}
