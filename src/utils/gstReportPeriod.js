export function gstReportPeriod(financialYear, startDate = '', endDate = '') {
  const year = Number(String(financialYear).slice(0,4));
  const fail = message => { throw Object.assign(new Error(message), {statusCode:400}); };
  if (!Number.isInteger(year) || year < 2017) fail('Invalid financial year');
  const fyStart = `${year}-04-01`, fyEnd = `${year+1}-03-31`;
  const valid = date => /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00.000Z`)) && new Date(`${date}T00:00:00.000Z`).toISOString().slice(0,10) === date;
  if ((startDate && !valid(startDate)) || (endDate && !valid(endDate))) fail('Invalid report date; use YYYY-MM-DD');
  const start = startDate || fyStart, end = endDate || fyEnd;
  if (start > end) fail('Start date must be on or before end date');
  if (start < fyStart || end > fyEnd) fail('Report dates must be within the selected financial year');
  return {startDate:start,endDate:end};
}
