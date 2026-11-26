// Tablet (kiosk) helpers: wording in Hebrew, English and Yiddish, input checks, label sizes.
// Pure — no DOM, no network — unit tested in tests/unit.

export const LANGS = {
  he: { dir: 'rtl', name: 'עברית' },
  en: { dir: 'ltr', name: 'English' },
  yi: { dir: 'rtl', name: 'אידיש' },
};

// Every language has exactly the same keys (checked by a unit test).
// The "how it works" steps are a draft until the organization sends its own wording.
export const TEXT = {
  he: {
    tagline: 'מסירת כביסה',
    kbdNext: 'הבא', kbdDone: 'סיום', kbdSpace: 'רווח',
    back: 'חזרה',
    infoTitle: 'איך זה עובד',
    infoSteps: [
      'ממלאים את השם ומספרי הטלפון.',
      'מדפיסים את המדבקות ומדביקים אחת על כל שקית.',
      'משאירים את השקיות כאן. נהג אוסף אותן, והן חוזרות נקיות תוך כיומיים.',
      'שומרים את הקבלה: עם המספר המזהה אפשר לבדוק או לבטל את המסירה בטאבלט הזה.',
    ],
    continue: 'המשך', haveId: 'יש לי מספר מזהה', haveIdSub: 'בדיקה או ביטול של מסירה',
    formTitle: 'הפרטים שלכם',
    first: 'שם פרטי', middle: 'שם אמצעי', optional: '(לא חובה)', last: 'שם משפחה',
    phoneHere: 'מספר טלפון כאן (באמריקה)', phoneIsrael: 'מספר טלפון בארץ ישראל',
    bags: 'כמה שקיות?', less: 'פחות', more: 'עוד', next: 'הצג את המדבקות שלי',
    previewTitle: 'בדקו את המדבקות',
    previewText: (b) => (b === 1 ? 'תקבלו מדבקה אחת לשקית, וקבלה אחת בשבילכם עם המספר המזהה.' : `תקבלו ${b} מדבקות, אחת לכל שקית, וקבלה אחת בשבילכם עם המספר המזהה.`),
    receipt: 'הקבלה שלכם', confirm: 'אישור והדפסה', edit: 'שינוי פרטים', sending: 'שולח…',
    doneTitle: 'הושלם!', printing: 'המדבקות מודפסות עכשיו…',
    stick: (b) => (b === 1 ? 'הדביקו את המדבקה על השקית ושמרו את הקבלה.' : 'הדביקו מדבקה אחת על כל שקית ושמרו את הקבלה.'),
    yourId: 'המספר המזהה שלכם', name: 'שם', bagsCount: 'שקיות', bagsWord: 'שקיות', date: 'תאריך',
    cancelNote: 'אם מסיבה כלשהי אתם לוקחים את השקיות בחזרה, היכנסו עם המספר המזהה ובטלו את המסירה.',
    howLogin: 'בטאבלט הזה: בחרו שפה ואז "יש לי מספר מזהה".',
    printAgain: 'הדפסה חוזרת', finish: 'סיום', resetIn: (s) => `המסך יחזור להתחלה בעוד ${s} שניות`,
    lookupTitle: 'יש לי מספר מזהה',
    idLabel: 'המספר המזהה (על הקבלה)', last4: '4 הספרות האחרונות של מספר הטלפון', find: 'המשך',
    statusTitle: 'המסירה שלכם',
    state_waiting: 'ממתין לאיסוף', state_picked_up: 'נאסף', state_cancelled: 'בוטל', state_returned: 'הוחזר',
    waitingNote: 'השקיות עוד לא נאספו. אם אתם לוקחים אותן בחזרה, בטלו כאן.',
    pickedNote: 'השקיות נאספו. לכל שינוי פנו בבקשה למשרד.',
    cancelBtn: 'ביטול המסירה', confirmCancelTitle: 'לבטל את המסירה?', confirmCancelText: 'הנהג לא יבוא לקחת את השקיות האלה.',
    yesCancel: 'כן, לבטל', noKeep: 'לא, להשאיר', cancelledMsg: 'המסירה בוטלה.',
    errFirst: 'נא להקליד שם פרטי.', errLast: 'נא להקליד שם משפחה.', errPhone: 'נא להקליד מספר טלפון תקין.',
    errBags: (max) => `מספר השקיות חייב להיות בין 1 ל־${max}.`,
    errId: 'נא להקליד את המספר המזהה מהקבלה.', errLast4: 'נא להקליד 4 ספרות.',
    notFound: 'לא מצאנו מסירה עם המספר והספרות האלה. בדקו ונסו שוב.',
    errServer: 'משהו השתבש. נסו שוב, או פנו למשרד.', errOffline: 'אין חיבור לאינטרנט. נסו שוב בעוד רגע.',
  },
  en: {
    tagline: 'Laundry drop-off',
    kbdNext: 'Next', kbdDone: 'Done', kbdSpace: 'space',
    back: 'Back',
    infoTitle: 'How it works',
    infoSteps: [
      'Fill in your name and phone numbers.',
      'Print your labels and put one on each bag.',
      'Leave your bags here. A driver picks them up, and they come back washed in about 2 days.',
      'Keep your receipt: with your ID number you can check or cancel your drop-off on this tablet.',
    ],
    continue: 'Continue', haveId: 'I have an ID number', haveIdSub: 'Check or cancel a drop-off',
    formTitle: 'Your details',
    first: 'First name', middle: 'Middle name', optional: '(optional)', last: 'Last name',
    phoneHere: 'Phone number here (America)', phoneIsrael: 'Phone number in Israel',
    bags: 'How many bags?', less: 'Fewer', more: 'More', next: 'Show my labels',
    previewTitle: 'Check your labels',
    previewText: (b) => (b === 1 ? 'You will get 1 label for your bag, and 1 receipt for you with your ID number.' : `You will get ${b} labels, one for each bag, and 1 receipt for you with your ID number.`),
    receipt: 'Your receipt', confirm: 'Confirm & print', edit: 'Change details', sending: 'Sending…',
    doneTitle: 'Completed!', printing: 'Your labels are printing now…',
    stick: (b) => (b === 1 ? 'Put the label on your bag and keep the receipt.' : 'Put one label on each bag and keep the receipt.'),
    yourId: 'Your ID number', name: 'Name', bagsCount: 'Bags', bagsWord: 'bags', date: 'Date',
    cancelNote: 'If for some reason you are taking your bags back, make sure to log in with your ID number and cancel.',
    howLogin: 'On this tablet: choose your language, then "I have an ID number".',
    printAgain: 'Print again', finish: 'Finish', resetIn: (s) => `This screen starts over in ${s} seconds`,
    lookupTitle: 'I have an ID number',
    idLabel: 'Your ID number (on your receipt)', last4: 'Last 4 digits of your phone number', find: 'Continue',
    statusTitle: 'Your drop-off',
    state_waiting: 'Waiting for pickup', state_picked_up: 'Picked up', state_cancelled: 'Cancelled', state_returned: 'Returned',
    waitingNote: 'Your bags have not been picked up yet. If you are taking them back, cancel here.',
    pickedNote: 'Your bags were picked up. To change anything, please ask the office.',
    cancelBtn: 'Cancel my drop-off', confirmCancelTitle: 'Cancel this drop-off?', confirmCancelText: 'The driver will not come for these bags.',
    yesCancel: 'Yes, cancel', noKeep: 'No, keep it', cancelledMsg: 'Your drop-off was cancelled.',
    errFirst: 'Please type your first name.', errLast: 'Please type your last name.', errPhone: 'Please type a valid phone number.',
    errBags: (max) => `Number of bags must be from 1 to ${max}.`,
    errId: 'Please type the ID number from your receipt.', errLast4: 'Please type 4 digits.',
    notFound: "We didn't find a drop-off with this ID and these digits. Please check and try again.",
    errServer: 'Something went wrong. Please try again, or ask the office.', errOffline: 'No internet connection. Please try again in a moment.',
  },
  yi: {
    tagline: 'אפגעבן וועש',
    kbdNext: 'ווייטער', kbdDone: 'פארטיג', kbdSpace: 'שפאציע',
    back: 'צוריק',
    infoTitle: 'ווי אזוי עס ארבעט',
    infoSteps: [
      'שרייבט אריין אייער נאמען און טעלעפאן נומערן.',
      'דרוקט די לעיבלס און קלעפט איינס אויף יעדן זאק.',
      'לאזט די זעק דא. א דרייווער נעמט זיי אפ, און זיי קומען צוריק געוואשן אין בערך 2 טעג.',
      'האלט אן אייער קבלה: מיט אייער ID נומער קענט איר נאכקוקן אדער אפשטעלן אויף דעם טאבלעט.',
    ],
    continue: 'ווייטער', haveId: 'איך האב אן ID נומער', haveIdSub: 'נאכקוקן אדער אפשטעלן',
    formTitle: 'אייערע פרטים',
    first: 'ערשטע נאמען', middle: 'מיטלסטע נאמען', optional: '(נישט נייטיג)', last: 'פאמיליע נאמען',
    phoneHere: 'טעלעפאן נומער דא (אין אמעריקע)', phoneIsrael: 'טעלעפאן נומער אין ארץ ישראל',
    bags: 'וויפיל זעק?', less: 'ווייניגער', more: 'מער', next: 'ווייזט מיינע לעיבלס',
    previewTitle: 'קוקט איבער אייערע לעיבלס',
    previewText: (b) => (b === 1 ? 'איר וועט באקומען 1 לעיבל פאר אייער זאק, און 1 קבלה פאר אייך מיט אייער ID נומער.' : `איר וועט באקומען ${b} לעיבלס, איינס פאר יעדן זאק, און 1 קבלה פאר אייך מיט אייער ID נומער.`),
    receipt: 'אייער קבלה', confirm: 'באשטעטיגן און דרוקן', edit: 'טוישן פרטים', sending: 'שיקט…',
    doneTitle: 'פארטיג!', printing: 'די לעיבלס ווערן יעצט געדרוקט…',
    stick: (b) => (b === 1 ? 'קלעפט דעם לעיבל אויף אייער זאק און האלט אן די קבלה.' : 'קלעפט איין לעיבל אויף יעדן זאק און האלט אן די קבלה.'),
    yourId: 'אייער ID נומער', name: 'נאמען', bagsCount: 'זעק', bagsWord: 'זעק', date: 'דאטום',
    cancelNote: 'אויב איר נעמט צוריק אייערע זעק צוליב סיי וועלכע סיבה, געדענקט אריינצוגיין מיט אייער ID נומער און עס אפשטעלן.',
    howLogin: 'אויף דעם טאבלעט: קלייבט אייער שפראך, און דערנאך "איך האב אן ID נומער".',
    printAgain: 'דרוקט נאכאמאל', finish: 'ענדיגן', resetIn: (s) => `דער סקרין הייבט זיך אן פון אנפאנג אין ${s} סעקונדעס`,
    lookupTitle: 'איך האב אן ID נומער',
    idLabel: 'אייער ID נומער (אויף די קבלה)', last4: 'די לעצטע 4 ציפערן פון אייער טעלעפאן נומער', find: 'ווייטער',
    statusTitle: 'אייער אפגעבונג',
    state_waiting: 'ווארט אויף אפנעמען', state_picked_up: 'אפגענומען', state_cancelled: 'אפגעשטעלט', state_returned: 'צוריקגעברענגט',
    waitingNote: 'די זעק זענען נאך נישט אפגענומען. אויב איר נעמט זיי צוריק, שטעלט עס אפ דא.',
    pickedNote: 'די זעק זענען אפגענומען געווארן. צו טוישן עפעס, ביטע פרעגט אין אפיס.',
    cancelBtn: 'אפשטעלן מיין אפגעבונג', confirmCancelTitle: 'אפשטעלן די אפגעבונג?', confirmCancelText: 'דער דרייווער וועט נישט קומען נאך די זעק.',
    yesCancel: 'יא, אפשטעלן', noKeep: 'ניין, לאזן', cancelledMsg: 'אייער אפגעבונג איז אפגעשטעלט געווארן.',
    errFirst: 'ביטע שרייבט אריין אייער ערשטע נאמען.', errLast: 'ביטע שרייבט אריין אייער פאמיליע נאמען.', errPhone: 'ביטע שרייבט אריין א ריכטיגע טעלעפאן נומער.',
    errBags: (max) => `די צאל זעק מוז זיין פון 1 ביז ${max}.`,
    errId: 'ביטע שרייבט אריין דעם ID נומער פון אייער קבלה.', errLast4: 'ביטע שרייבט אריין 4 ציפערן.',
    notFound: 'מיר האבן נישט געטראפן קיין אפגעבונג מיט דעם נומער און די ציפערן. ביטע קוקט איבער און פרובירט נאכאמאל.',
    errServer: 'עפעס איז נישט געגאנגען. פרובירט נאכאמאל, אדער פרעגט אין אפיס.', errOffline: 'נישטא קיין אינטערנעט. פרובירט נאכאמאל אין א מינוט.',
  },
};

// Label sizes offered in Settings. css = the @page size used when printing.
export const LABEL_SIZES = {
  '4x6': { label: '4 × 6 in (shipping label printers: Rollo, Zebra, Munbyn…)', css: '4in 6in' },
  '62mm': { label: '62 × 100 mm (Brother QL)', css: '62mm 100mm' },
  '2.25x1.25': { label: '2.25 × 1.25 in (Dymo small)', css: '2.25in 1.25in' },
  letter: { label: 'Full page (regular printer)', css: 'letter' },
};

export const phoneDigits = (p) => String(p ?? '').replace(/\D/g, '');
const tidy = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

// Drop-off form. The phone in Israel is optional and taken as typed.
// Returns { ok, errors: { first?, last?, phone?, bags? }, value }.
export function checkDropOff(v, maxBags, lang = 'he') {
  const t = TEXT[lang] || TEXT.he;
  const value = { first: tidy(v.first), middle: tidy(v.middle), last: tidy(v.last),
    phone: String(v.phone ?? '').trim(), israel: String(v.israel ?? '').trim().slice(0, 30), bags: Number(v.bags) };
  const errors = {};
  if (!value.first || value.first.length > 40) errors.first = t.errFirst;
  if (!value.last || value.last.length > 40) errors.last = t.errLast;
  const d = phoneDigits(value.phone).length;
  if (d < 7 || d > 15) errors.phone = t.errPhone;
  if (!Number.isInteger(value.bags) || value.bags < 1 || value.bags > maxBags) errors.bags = t.errBags(maxBags);
  return { ok: !Object.keys(errors).length, errors, value };
}

// "I have an ID number": the ID (order number, "K-" optional) and the last 4 digits of a phone.
export function checkLookup(v, lang = 'he') {
  const t = TEXT[lang] || TEXT.he;
  const id = phoneDigits(v.id);
  const last4 = phoneDigits(v.last4);
  const errors = {};
  if (!id || id.length > 9) errors.id = t.errId;
  if (last4.length !== 4) errors.last4 = t.errLast4;
  return { ok: !Object.keys(errors).length, errors, value: { id: id ? Number(id) : null, last4 } };
}

// ---------------------------------------------------------------
// In-app keyboard: the Windows keyboard never opens; each kind of box gets only the keys it needs.
// ---------------------------------------------------------------
export const KBD_ALLOWED = {
  name: /^[\p{L}\p{M} '\-]$/u,     // letters in any language, space, apostrophe, dash
  phone: /^[0-9+\-() ]$/,
  digits: /^[0-9]$/,
};

export const KBD_LAYOUTS = {
  phone: [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['+', '0', '-'], ['(', ')', 'space']],
  digits: [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['0']],
  en: [['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'], ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm', "'", '-']],
  he: [['ק', 'ר', 'א', 'ט', 'ו', 'ן', 'ם', 'פ'], ['ש', 'ד', 'ג', 'כ', 'ע', 'י', 'ח', 'ל', 'ך', 'ף'],
    ['ז', 'ס', 'ב', 'ה', 'נ', 'מ', 'צ', 'ת', 'ץ'], ['ײ', 'װ', 'ױ', "'", '-']],
};

// The new value of a box after one key: 'back', 'space' or a character. Characters the box doesn't
// accept are ignored; names start each word with a capital (English) and never get double spaces.
export function typeKey(value, key, kind, max = 40) {
  const v = String(value ?? '');
  if (key === 'back') return Array.from(v).slice(0, -1).join('');
  const ch = key === 'space' ? ' ' : key;
  if (!KBD_ALLOWED[kind]?.test(ch) || Array.from(v).length >= max) return v;
  if (kind === 'name' && ch === ' ' && (v === '' || v.endsWith(' '))) return v;
  const wordStart = v === '' || /[ \-']$/.test(v);
  return v + (kind === 'name' && wordStart && /^[a-z]$/.test(ch) ? ch.toUpperCase() : ch);
}

// One label per bag: [{ index: 1, of: 3 }, …]
export function labelPages(bags) {
  const n = Math.max(1, Math.min(100, Number(bags) || 1));
  return Array.from({ length: n }, (_, i) => ({ index: i + 1, of: n }));
}
