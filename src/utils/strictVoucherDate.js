// Strict manual voucher dates: DD-MM-YYYY or YYYY-MM-DD only.
// Never let JavaScript/Excel guess the meaning of dates, or replace a missing
// date with the current day. Excel numeric serials without a date format fail.
export function parseStrictVoucherDate(value) {
  if (typeof value !== "string") throw Object.assign(new Error("Date must be DD-MM-YYYY or YYYY-MM-DD (text, not an Excel serial number)"),{statusCode:400});
  const text=value.trim();
  let year, month, day;
  let match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) [,year,month,day]=match;
  else {
    match=/^(\d{2})-(\d{2})-(\d{4})$/.exec(text);
    if (!match) throw Object.assign(new Error("Invalid date format. Use DD-MM-YYYY or YYYY-MM-DD only."),{statusCode:400});
    [,day,month,year]=match;
  }
  year=Number(year); month=Number(month); day=Number(day);
  const date=new Date(Date.UTC(year,month-1,day));
  if (year<1900 || year>2100 || date.getUTCFullYear()!==year || date.getUTCMonth()!==month-1 || date.getUTCDate()!==day)
    throw Object.assign(new Error("Invalid calendar date. Use DD-MM-YYYY or YYYY-MM-DD (for example 29-10-2026)."),{statusCode:400});
  return date;
}
