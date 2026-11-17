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
    mail_inactive_subject: 'Your {brand} account will be deleted',
    mail_inactive_body:
      'Your account at {brand} has not been used for a long time. It will be deleted on {date} unless you sign in to any service that uses {brand} before then. Signing in keeps your account; nothing else is needed.',
    mail_privacy_link: 'Privacy notice: {url}',
    footer_privacy: 'Privacy notice',
    privacy_title: 'Privacy notice',
    privacy_controller: 'Data controller',
    privacy_dpo: 'Data protection officer',
    privacy_contact: 'Contact: {contact}',
    privacy_stored: 'What we store',
    privacy_stored_body:
      'Your email address, display name, group memberships, sign-in times and audit log entries about your account.',
    privacy_why: 'Why we store it',
    privacy_why_body:
      'So that you can sign in to services that use {brand}, and so that sign-in stays secure.',
    privacy_retention: 'How long we keep it',
    privacy_inactive:
      'An account with no sign-in for {days} days is deleted. You get an email {warnDays} days before that. Signing in at any time keeps the account.',
    privacy_admins: 'Administrator accounts are not deleted automatically.',
    privacy_audit: 'Audit log entries are deleted after {days} days.',
    privacy_audit_ip: 'IP addresses are removed from audit log entries after {days} days.',
    privacy_processors: 'Processors',
    privacy_processors_none: 'No processors are listed.',
    privacy_processor_name: 'Processor',
    privacy_processor_purpose: 'Purpose',
    privacy_processor_location: 'Location',
    privacy_rights: 'Your rights',
    privacy_rights_body:
      'You can ask the data controller for access to your data, correction or deletion of it, and restriction of its processing. You can also complain to a data protection supervisory authority.',
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
    mail_inactive_subject: '{brand}-tilisi poistetaan',
    mail_inactive_body:
      'Tiliäsi {brand}-palvelussa ei ole käytetty pitkään aikaan. Tili poistetaan {date}, ellei kirjaudu sisään ennen sitä mihinkään palveluun, joka käyttää {brand}-kirjautumista. Kirjautuminen säilyttää tilisi, eikä muita toimia tarvita.',
    mail_privacy_link: 'Tietosuojaseloste: {url}',
    footer_privacy: 'Tietosuojaseloste',
    privacy_title: 'Tietosuojaseloste',
    privacy_controller: 'Rekisterinpitäjä',
    privacy_dpo: 'Tietosuojavastaava',
    privacy_contact: 'Yhteystiedot: {contact}',
    privacy_stored: 'Mitä tietoja tallennamme',
    privacy_stored_body:
      'Sähköpostiosoitteesi, näyttönimesi, ryhmäjäsenyytesi, kirjautumisajat ja tiliäsi koskevat lokimerkinnät.',
    privacy_why: 'Miksi tietoja tallennetaan',
    privacy_why_body:
      'Jotta voit kirjautua palveluihin, jotka käyttävät {brand}-kirjautumista, ja jotta kirjautuminen pysyy turvallisena.',
    privacy_retention: 'Kuinka kauan tietoja säilytetään',
    privacy_inactive:
      'Tili, jolla ei ole kirjauduttu sisään {days} päivään, poistetaan. Saat sähköpostin {warnDays} päivää ennen poistoa. Kirjautuminen milloin tahansa säilyttää tilin.',
    privacy_admins: 'Ylläpitäjien tilejä ei poisteta automaattisesti.',
    privacy_audit: 'Lokimerkinnät poistetaan {days} päivän kuluttua.',
    privacy_audit_ip: 'IP-osoitteet poistetaan lokimerkinnöistä {days} päivän kuluttua.',
    privacy_processors: 'Käsittelijät',
    privacy_processors_none: 'Käsittelijöitä ei ole ilmoitettu.',
    privacy_processor_name: 'Käsittelijä',
    privacy_processor_purpose: 'Tarkoitus',
    privacy_processor_location: 'Sijainti',
    privacy_rights: 'Oikeutesi',
    privacy_rights_body:
      'Voit pyytää rekisterinpitäjältä pääsyä tietoihisi, niiden korjaamista tai poistamista sekä käsittelyn rajoittamista. Voit myös tehdä valituksen tietosuojavaltuutetulle.',
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
    mail_inactive_subject: 'Ditt {brand}-konto raderas',
    mail_inactive_body:
      'Ditt konto hos {brand} har inte använts på länge. Det raderas den {date} om du inte loggar in i någon tjänst som använder {brand} före dess. Om du loggar in behålls kontot, och du behöver inte göra något mer.',
    mail_privacy_link: 'Integritetspolicy: {url}',
    footer_privacy: 'Integritetspolicy',
    privacy_title: 'Integritetspolicy',
    privacy_controller: 'Personuppgiftsansvarig',
    privacy_dpo: 'Dataskyddsombud',
    privacy_contact: 'Kontakt: {contact}',
    privacy_stored: 'Vilka uppgifter vi sparar',
    privacy_stored_body:
      'Din e-postadress, ditt visningsnamn, dina gruppmedlemskap, dina inloggningstider och loggposter om ditt konto.',
    privacy_why: 'Varför vi sparar uppgifterna',
    privacy_why_body:
      'För att du ska kunna logga in i tjänster som använder {brand} och för att inloggningen ska vara säker.',
    privacy_retention: 'Hur länge uppgifterna sparas',
    privacy_inactive:
      'Ett konto utan inloggning under {days} dagar raderas. Du får ett e-postmeddelande {warnDays} dagar före det. Om du loggar in behålls kontot.',
    privacy_admins: 'Administratörskonton raderas inte automatiskt.',
    privacy_audit: 'Loggposter raderas efter {days} dagar.',
    privacy_audit_ip: 'IP-adresser tas bort från loggposter efter {days} dagar.',
    privacy_processors: 'Personuppgiftsbiträden',
    privacy_processors_none: 'Inga personuppgiftsbiträden har angetts.',
    privacy_processor_name: 'Personuppgiftsbiträde',
    privacy_processor_purpose: 'Syfte',
    privacy_processor_location: 'Plats',
    privacy_rights: 'Dina rättigheter',
    privacy_rights_body:
      'Du kan be den personuppgiftsansvarige om tillgång till dina uppgifter, rättelse eller radering av dem och begränsning av behandlingen. Du kan också lämna klagomål till en tillsynsmyndighet för dataskydd.',
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
 * Pick the locale from Accept-Language, falling back to the default. Without an
 * Accept-Language header, or one that accepts anything (`*`), the default is used:
 * negotiation would otherwise return the first supported locale.
 * @param {{ headers: Record<string, string | string[] | undefined>, acceptsLanguages(...l: string[]): string | false }} req
 * @param {Locale} fallback
 * @returns {Locale}
 */
export function pickLocale(req, fallback) {
  const header = req.headers['accept-language'];
  if (!header || header === '*') return fallback;
  const hit = req.acceptsLanguages(...LOCALES);
  return hit && /** @type {readonly string[]} */ (LOCALES).includes(hit)
    ? /** @type {Locale} */ (hit)
    : fallback;
}
