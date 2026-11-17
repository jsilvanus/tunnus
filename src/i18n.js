export const LOCALES = /** @type {const} */ (['fi', 'sv', 'en']);

/** @typedef {typeof LOCALES[number]} Locale */

/** @type {Record<Locale, Record<string, string>>} */
const messages = {
  en: {
    signin: 'Sign in',
    email: 'Email address',
    send_code: 'Send code',
    invalid_email: 'Enter a valid email address.',
    code_sent: 'If the address can sign in, we have sent a 6-digit code to it.',
    code: 'Code',
    continue: 'Continue',
    invalid_code: 'That code is not valid.',
    name_title: 'Your name',
    name_help: 'This name is shown to the apps you sign in to. You can change it.',
    name: 'Display name',
    create_account: 'Create account',
    continue_as: 'Continue as {name}',
    other_account: 'Sign in with another account',
    consent: '{client} wants access to: {scopes}.',
    allow: 'Allow',
    deny: 'Deny',
    privacy: 'Privacy',
    link_title: 'Confirm sign-in',
    link_help: 'Confirm that you want to sign in.',
    link_other_browser: 'Type this code in the window where you started signing in:',
    link_invalid: 'This link is not valid any more. Start signing in again.',
    mail_subject: 'Your sign-in code: {code}',
    mail_body:
      'Your sign-in code is {code}. It is valid for 10 minutes.\n\nOr open this link to sign in:\n{link}\n\nIf you did not try to sign in, ignore this message.',
    mail_controller: 'Data controller: {controller}',
  },
  fi: {
    signin: 'Kirjaudu',
    email: 'Sähköpostiosoite',
    send_code: 'Lähetä koodi',
    invalid_email: 'Anna kelvollinen sähköpostiosoite.',
    code_sent: 'Jos osoitteella voi kirjautua, lähetimme siihen 6-numeroisen koodin.',
    code: 'Koodi',
    continue: 'Jatka',
    invalid_code: 'Koodi ei kelpaa.',
    name_title: 'Nimesi',
    name_help: 'Nimi näytetään sovelluksille, joihin kirjaudut. Voit muuttaa sitä.',
    name: 'Näyttönimi',
    create_account: 'Luo tili',
    continue_as: 'Jatka käyttäjänä {name}',
    other_account: 'Kirjaudu toisella tilillä',
    consent: '{client} pyytää pääsyä tietoihin: {scopes}.',
    allow: 'Salli',
    deny: 'Kieltäydy',
    privacy: 'Tietosuoja',
    link_title: 'Vahvista kirjautuminen',
    link_help: 'Vahvista, että haluat kirjautua.',
    link_other_browser: 'Kirjoita tämä koodi ikkunaan, jossa aloitit kirjautumisen:',
    link_invalid: 'Linkki ei ole enää voimassa. Aloita kirjautuminen uudelleen.',
    mail_subject: 'Kirjautumiskoodisi: {code}',
    mail_body:
      'Kirjautumiskoodisi on {code}. Se on voimassa 10 minuuttia.\n\nVoit myös kirjautua tästä linkistä:\n{link}\n\nJos et yrittänyt kirjautua, voit ohittaa tämän viestin.',
    mail_controller: 'Rekisterinpitäjä: {controller}',
  },
  sv: {
    signin: 'Logga in',
    email: 'E-postadress',
    send_code: 'Skicka kod',
    invalid_email: 'Ange en giltig e-postadress.',
    code_sent: 'Om adressen kan logga in har vi skickat en 6-siffrig kod till den.',
    code: 'Kod',
    continue: 'Fortsätt',
    invalid_code: 'Koden är inte giltig.',
    name_title: 'Ditt namn',
    name_help: 'Namnet visas för apparna du loggar in i. Du kan ändra det.',
    name: 'Visningsnamn',
    create_account: 'Skapa konto',
    continue_as: 'Fortsätt som {name}',
    other_account: 'Logga in med ett annat konto',
    consent: '{client} vill ha tillgång till: {scopes}.',
    allow: 'Tillåt',
    deny: 'Neka',
    privacy: 'Integritet',
    link_title: 'Bekräfta inloggning',
    link_help: 'Bekräfta att du vill logga in.',
    link_other_browser: 'Skriv den här koden i fönstret där du började logga in:',
    link_invalid: 'Länken är inte längre giltig. Börja logga in på nytt.',
    mail_subject: 'Din inloggningskod: {code}',
    mail_body:
      'Din inloggningskod är {code}. Den gäller i 10 minuter.\n\nEller öppna den här länken för att logga in:\n{link}\n\nOm du inte försökte logga in kan du bortse från meddelandet.',
    mail_controller: 'Personuppgiftsansvarig: {controller}',
  },
};

/**
 * Translate a key, replacing `{name}` placeholders.
 * @param {Locale} locale
 * @param {string} key
 * @param {Record<string, string>} [vars]
 */
export function t(locale, key, vars = {}) {
  const text = messages[locale][key] ?? messages.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, n) => vars[n] ?? '');
}

/**
 * Pick the locale from Accept-Language, falling back to the default.
 * @param {{ acceptsLanguages(...l: string[]): string | false }} req
 * @param {Locale} fallback
 * @returns {Locale}
 */
export function pickLocale(req, fallback) {
  const hit = req.acceptsLanguages(...LOCALES);
  return hit && /** @type {readonly string[]} */ (LOCALES).includes(hit)
    ? /** @type {Locale} */ (hit)
    : fallback;
}
