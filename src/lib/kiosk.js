// Tablet (kiosk) helpers: wording in Hebrew, English and Yiddish, input checks, label sizes, tracking stages.
// Pure — no DOM, no network — unit tested in tests/unit.

export const LANGS = {
  he: { dir: 'rtl', name: 'עברית' },
  en: { dir: 'ltr', name: 'English' },
  yi: { dir: 'rtl', name: 'אידיש' },
};

// Every language has exactly the same keys (checked by a unit test).
export const TEXT = {
  he: {
    tagline: 'מסירת כביסה ומעקב',
    menuTitle: 'מה תרצו לעשות?',
    newCall: 'מסירת כביסה', newCallSub: 'קבלו מדבקות לשקיות שלכם',
    track: 'איפה הכביסה שלי?', trackSub: 'בדקו איפה השקיות שלכם עכשיו',
    back: 'חזרה',
    formTitle: 'מסירת כביסה',
    first: 'שם פרטי', middle: 'שם אמצעי', optional: '(לא חובה)', last: 'שם משפחה',
    phoneHere: 'מספר טלפון כאן (באמריקה)', phoneIsrael: 'מספר טלפון בארץ ישראל',
    bags: 'כמה שקיות?', less: 'פחות', more: 'עוד',
    printLabels: 'הדפסת המדבקות שלי', sending: 'שולח…',
    labelsTitle: 'המדבקות שלכם',
    labelsPrinting: 'המדבקות מודפסות עכשיו…',
    labelsStep1: (b) => (b === 1 ? 'קחו את המדבקה מהמדפסת והדביקו אותה על השקית.' : `קחו את ${b} המדבקות מהמדפסת והדביקו מדבקה אחת על כל שקית.`),
    labelsStep2: 'כשכל המדבקות על השקיות, לחצו "סיימתי".',
    printAgain: 'הדפסה חוזרת', labelsDone: 'סיימתי — המדבקות על השקיות',
    bagOf: (i, n) => `שקית ${i} מתוך ${n}`,
    summaryTitle: 'הכול מוכן!', yourNo: 'מספר ההזמנה שלכם',
    name: 'שם', bagsCount: 'שקיות', date: 'תאריך', welcomeBack: 'שמחים לראותכם שוב.',
    trackHint: 'תמיד אפשר לבדוק איפה הכביסה: בטאבלט הזה לחצו "איפה הכביסה שלי?" והקלידו את מספר הטלפון והשם הפרטי.',
    finish: 'סיום', resetIn: (s) => `המסך יחזור להתחלה בעוד ${s} שניות`,
    trackTitle: 'איפה הכביסה שלי?',
    trackPhone: 'מספר הטלפון שלכם (כאן או בארץ ישראל)', trackFirst: 'השם הפרטי שלכם', trackFind: 'הצג את הכביסה שלי',
    trackNone: 'לא מצאנו כביסה למספר ולשם האלה.', trackAuto: 'מתעדכן אוטומטית',
    order: 'הזמנה', droppedOff: 'נמסר', bagsWord: 'שקיות', now: 'עכשיו:',
    step_pickup: 'נמסר', step_washing: 'בכביסה', step_return: 'כובס', step_delivered: 'הוחזר',
    stage_pickup: 'ממתין לנהג שיאסוף', stage_washing: 'נאסף — בכביסה', stage_return: 'כובס — ממתין להחזרה', stage_delivered: 'הוחזר',
    stage_attention: 'המשרד בודק את ההזמנה הזו', stage_cancelled: 'בוטל',
    errFirst: 'נא להקליד שם פרטי.', errLast: 'נא להקליד שם משפחה.',
    errPhone: 'נא להקליד מספר טלפון תקין.', errIsrael: 'נא להקליד מספר טלפון תקין בארץ ישראל.',
    errBags: (max) => `מספר השקיות חייב להיות בין 1 ל־${max}.`,
    errServer: 'משהו השתבש. נסו שוב, או פנו למשרד.', errOffline: 'אין חיבור לאינטרנט. נסו שוב בעוד רגע.',
    exitTitle: 'יציאה ממצב טאבלט', exitPrompt: 'הקלידו את הסיסמה של חשבון הטאבלט כדי לצאת.', password: 'סיסמה', exit: 'יציאה', cancel: 'ביטול',
    errPassword: 'סיסמה שגויה.',
  },
  en: {
    tagline: 'Laundry drop-off & tracking',
    menuTitle: 'What would you like to do?',
    newCall: 'Drop off laundry', newCallSub: 'Get labels for your bags',
    track: 'Where is my laundry?', trackSub: 'See where your bags are now',
    back: 'Back',
    formTitle: 'Drop off laundry',
    first: 'First name', middle: 'Middle name', optional: '(optional)', last: 'Last name',
    phoneHere: 'Phone number here (America)', phoneIsrael: 'Phone number in Israel',
    bags: 'How many bags?', less: 'Fewer', more: 'More',
    printLabels: 'Print my labels', sending: 'Sending…',
    labelsTitle: 'Your labels',
    labelsPrinting: 'Your labels are printing now…',
    labelsStep1: (b) => (b === 1 ? 'Take the label from the printer and put it on your bag.' : `Take the ${b} labels from the printer and put one on each bag.`),
    labelsStep2: 'When all the labels are on your bags, press "Done".',
    printAgain: 'Print again', labelsDone: 'Done — the labels are on',
    bagOf: (i, n) => `Bag ${i} of ${n}`,
    summaryTitle: 'All set!', yourNo: 'Your order number',
    name: 'Name', bagsCount: 'Bags', date: 'Date', welcomeBack: 'Welcome back.',
    trackHint: 'You can check on your laundry any time: on this tablet, tap "Where is my laundry?" and type your phone number and first name.',
    finish: 'Finish', resetIn: (s) => `This screen starts over in ${s} seconds`,
    trackTitle: 'Where is my laundry?',
    trackPhone: 'Your phone number (here or in Israel)', trackFirst: 'Your first name', trackFind: 'Show my laundry',
    trackNone: "We didn't find any laundry for this phone number and name.", trackAuto: 'Updates automatically',
    order: 'Order', droppedOff: 'Dropped off', bagsWord: 'bags', now: 'Now:',
    step_pickup: 'Dropped off', step_washing: 'Being washed', step_return: 'Washed', step_delivered: 'Brought back',
    stage_pickup: 'Waiting for a driver to pick it up', stage_washing: 'Picked up — being washed', stage_return: 'Washed — waiting to be brought back', stage_delivered: 'Brought back',
    stage_attention: 'The office is checking on this order', stage_cancelled: 'Cancelled',
    errFirst: 'Please type your first name.', errLast: 'Please type your last name.',
    errPhone: 'Please type a valid phone number.', errIsrael: 'Please type a valid phone number in Israel.',
    errBags: (max) => `Number of bags must be from 1 to ${max}.`,
    errServer: 'Something went wrong. Please try again, or ask the office.', errOffline: 'No internet connection. Please try again in a moment.',
    exitTitle: 'Leave tablet mode', exitPrompt: "Type the tablet account's password to leave.", password: 'Password', exit: 'Leave', cancel: 'Cancel',
    errPassword: 'Wrong password.',
  },
  yi: {
    tagline: 'אפגעבן וועש און נאכקוקן',
    menuTitle: 'וואס ווילט איר טון?',
    newCall: 'אפגעבן וועש', newCallSub: 'באקומט לעיבלס פאר אייערע זעק',
    track: 'וואו איז מיין וועש?', trackSub: 'זעט וואו אייערע זעק האלטן יעצט',
    back: 'צוריק',
    formTitle: 'אפגעבן וועש',
    first: 'ערשטע נאמען', middle: 'מיטלסטע נאמען', optional: '(נישט נייטיג)', last: 'פאמיליע נאמען',
    phoneHere: 'טעלעפאן נומער דא (אין אמעריקע)', phoneIsrael: 'טעלעפאן נומער אין ארץ ישראל',
    bags: 'וויפיל זעק?', less: 'ווייניגער', more: 'מער',
    printLabels: 'דרוקט מיינע לעיבלס', sending: 'שיקט…',
    labelsTitle: 'אייערע לעיבלס',
    labelsPrinting: 'די לעיבלס ווערן יעצט געדרוקט…',
    labelsStep1: (b) => (b === 1 ? 'נעמט דעם לעיבל פון פרינטער און קלעפט עס אויף אייער זאק.' : `נעמט די ${b} לעיבלס פון פרינטער און קלעפט איינס אויף יעדן זאק.`),
    labelsStep2: 'ווען אלע לעיבלס זענען אויף די זעק, דרוקט "פארטיג".',
    printAgain: 'דרוקט נאכאמאל', labelsDone: 'פארטיג — די לעיבלס זענען אויף',
    bagOf: (i, n) => `זאק ${i} פון ${n}`,
    summaryTitle: 'אלעס איז גרייט!', yourNo: 'אייער ארדער נומער',
    name: 'נאמען', bagsCount: 'זעק', date: 'דאטום', welcomeBack: 'מיר פרייען זיך אייך ווידער צו זען.',
    trackHint: 'איר קענט אלעמאל נאכקוקן אייער וועש: אויף דעם טאבלעט, דרוקט "וואו איז מיין וועש?" און שרייבט אריין אייער טעלעפאן נומער און ערשטע נאמען.',
    finish: 'ענדיגן', resetIn: (s) => `דער סקרין הייבט זיך אן פון אנפאנג אין ${s} סעקונדעס`,
    trackTitle: 'וואו איז מיין וועש?',
    trackPhone: 'אייער טעלעפאן נומער (דא אדער אין ארץ ישראל)', trackFirst: 'אייער ערשטע נאמען', trackFind: 'ווייזט מיין וועש',
    trackNone: 'מיר האבן נישט געטראפן קיין וועש פאר דעם נומער און נאמען.', trackAuto: 'דערהיינטיגט זיך אליין',
    order: 'ארדער', droppedOff: 'אפגעגעבן', bagsWord: 'זעק', now: 'יעצט:',
    step_pickup: 'אפגעגעבן', step_washing: 'ווערט געוואשן', step_return: 'געוואשן', step_delivered: 'צוריקגעברענגט',
    stage_pickup: 'ווארט אויף א דרייווער עס אפצונעמען', stage_washing: 'אפגענומען — ווערט געוואשן', stage_return: 'געוואשן — ווארט צו ווערן צוריקגעברענגט', stage_delivered: 'צוריקגעברענגט',
    stage_attention: 'די אפיס קוקט נאך די ארדער', stage_cancelled: 'אפגעשטעלט',
    errFirst: 'ביטע שרייבט אריין אייער ערשטע נאמען.', errLast: 'ביטע שרייבט אריין אייער פאמיליע נאמען.',
    errPhone: 'ביטע שרייבט אריין א ריכטיגע טעלעפאן נומער.', errIsrael: 'ביטע שרייבט אריין א ריכטיגע טעלעפאן נומער אין ארץ ישראל.',
    errBags: (max) => `די צאל זעק מוז זיין פון 1 ביז ${max}.`,
    errServer: 'עפעס איז נישט געגאנגען. פרובירט נאכאמאל, אדער פרעגט אין אפיס.', errOffline: 'נישטא קיין אינטערנעט. פרובירט נאכאמאל אין א מינוט.',
    exitTitle: 'ארויסגיין פון טאבלעט', exitPrompt: 'שרייבט אריין דעם פאסווארט פון טאבלעט אקאונט כדי ארויסצוגיין.', password: 'פאסווארט', exit: 'ארויסגיין', cancel: 'צוריק',
    errPassword: 'פאלשער פאסווארט.',
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
const okPhone = (p) => { const d = phoneDigits(p).length; return d >= 7 && d <= 15; };
const tidy = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

// New drop-off form. Returns { ok, errors: { first?, last?, phone?, israel?, bags? }, value }.
export function checkDropOff(v, maxBags, lang = 'he') {
  const t = TEXT[lang] || TEXT.he;
  const value = { first: tidy(v.first), middle: tidy(v.middle), last: tidy(v.last),
    phone: String(v.phone ?? '').trim(), israel: String(v.israel ?? '').trim(), bags: Number(v.bags) };
  const errors = {};
  if (!value.first || value.first.length > 40) errors.first = t.errFirst;
  if (!value.last || value.last.length > 40) errors.last = t.errLast;
  if (!okPhone(value.phone)) errors.phone = t.errPhone;
  if (!okPhone(value.israel)) errors.israel = t.errIsrael;
  if (!Number.isInteger(value.bags) || value.bags < 1 || value.bags > maxBags) errors.bags = t.errBags(maxBags);
  return { ok: !Object.keys(errors).length, errors, value };
}

// "Where is my laundry?" form.
export function checkTrack(v, lang = 'he') {
  const t = TEXT[lang] || TEXT.he;
  const value = { phone: String(v.phone ?? '').trim(), first: tidy(v.first) };
  const errors = {};
  if (!okPhone(value.phone)) errors.phone = t.errPhone;
  if (!value.first) errors.first = t.errFirst;
  return { ok: !Object.keys(errors).length, errors, value };
}

// The four steps a meshulach sees, from the detailed order status.
export const STAGES = ['pickup', 'washing', 'return', 'delivered'];
export function stageOf(status) {
  switch (status) {
    case 'requested': case 'scheduled': case 'pickup_in_progress': return 'pickup';
    case 'awaiting_dropoff': case 'awaiting_washing': case 'washing_in_progress': return 'washing';
    case 'ready_for_return': case 'return_collection_in_progress': case 'out_for_delivery': return 'return';
    case 'completed': return 'delivered';
    case 'cancelled': return 'cancelled';
    default: return 'attention';
  }
}

// One label per bag: [{ index: 1, of: 3 }, …]
export function labelPages(bags) {
  const n = Math.max(1, Math.min(100, Number(bags) || 1));
  return Array.from({ length: n }, (_, i) => ({ index: i + 1, of: n }));
}
