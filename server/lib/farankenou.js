/**
 * Parser for Farankenou (فراننکو) attendance export files (.lwte).
 * Format: UTF-8, CRLF, TAB-separated, 33 columns.
 */

const COLUMNS = [
  'employeeNo', 'cardNo', 'name', 'family', 'year', 'month',
  'monthWorkingDays', 'monthPresentDays', 'monthDuration', 'workingDuration',
  'nightWorking', 'overBefore', 'overHoliday', 'overMission', 'overtime',
  'overForbidden', 'totalOverTime', 'late', 'earlyGo', 'deduction',
  'lateAllowed', 'totalDeduction', 'absenceDays', 'missionHours', 'missionDays',
  'vacationBedoneHoghoghDays', 'vacationEstehghaghiDays', 'vacationEstelajiDays',
  'vacationHours', 'vacationSayerDays', 'vacationTashvighiDays', 'workRule', 'workGroup'
];

/** Parse D.HH:MM:SS (days + time) or HH:MM:SS → decimal hours */
function parseDuration(raw) {
  const s = String(raw || '').trim();
  if (!s || s === '0') return 0;

  const dayTime = s.match(/^(\d+)\.(\d{1,2}):(\d{2}):(\d{2})$/);
  if (dayTime) {
    const days = parseInt(dayTime[1], 10);
    const h = parseInt(dayTime[2], 10);
    const m = parseInt(dayTime[3], 10);
    const sec = parseInt(dayTime[4], 10);
    return days * 24 + h + m / 60 + sec / 3600;
  }

  const plain = s.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (plain) {
    const h = parseInt(plain[1], 10);
    const m = parseInt(plain[2], 10);
    const sec = parseInt(plain[3], 10);
    return h + m / 60 + sec / 3600;
  }

  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function normName(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

function parseFarankenouText(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];

  const header = lines[0].split('\t').map(c => c.trim());
  const hasHeader = header[0] === 'employeeNo' || header.includes('employeeNo');
  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines.map((line, idx) => {
    const cols = line.split('\t');
    const row = {};
    COLUMNS.forEach((key, i) => { row[key] = (cols[i] || '').trim(); });

    const year = parseInt(row.year, 10) || 0;
    const month = parseInt(row.month, 10) || 0;
    const regularHours = parseDuration(row.workingDuration);
    const overtimeHours = parseDuration(row.totalOverTime);
    const deductionHours = parseDuration(row.totalDeduction);
    const absenceDays = parseFloat(row.absenceDays) || 0;

    return {
      line: idx + (hasHeader ? 2 : 1),
      employeeNo: row.employeeNo,
      cardNo: row.cardNo,
      name: normName(row.name),
      family: normName(row.family),
      fullName: normName(`${row.name} ${row.family}`),
      year,
      month,
      periodLabel: year && month ? `${year}/${String(month).padStart(2, '0')}` : '',
      monthWorkingDays: parseInt(row.monthWorkingDays, 10) || 0,
      monthPresentDays: parseInt(row.monthPresentDays, 10) || 0,
      regularHours: Math.round(regularHours * 100) / 100,
      overtimeHours: Math.round(overtimeHours * 100) / 100,
      deductionHours: Math.round(deductionHours * 100) / 100,
      absenceDays,
      workRule: row.workRule,
      workGroup: row.workGroup,
      raw: row
    };
  });
}

function parseFarankenouBuffer(buffer) {
  let text = buffer.toString('utf8');
  if (text.includes('\uFFFD') || !text.includes('employeeNo') && !text.includes('\t')) {
    try { text = buffer.toString('latin1'); } catch (_) { /* keep utf8 */ }
  }
  return parseFarankenouText(text);
}

/**
 * Compute payroll amounts from parsed row + person rates.
 * deductionHours from Farankenou is time-based penalty → converted to money via hourly rate.
 * absenceDays: if monthWorkingDays > 0, each day = (monthDuration hours / monthWorkingDays) * hourly_rate
 */
function calcPayrollFromAttendance(row, person, opts = {}) {
  const hourlyRate = parseFloat(opts.hourly_rate) || parseFloat(person?.hourly_rate) || 0;
  const overtimeRate = parseFloat(opts.overtime_rate) || parseFloat(person?.overtime_rate) || (hourlyRate * 1.4);
  const insurancePct = parseFloat(opts.insurance_percent) ?? parseFloat(person?.insurance_percent) ?? 0;
  const taxPct = parseFloat(opts.tax_percent) ?? parseFloat(person?.tax_percent) ?? 0;

  const timeDeduction = row.deductionHours * hourlyRate;
  let absenceDeduction = 0;
  if (row.absenceDays > 0 && row.monthWorkingDays > 0 && hourlyRate > 0) {
    const monthHours = parseDuration(row.raw?.monthDuration);
    const hoursPerDay = monthHours > 0 ? monthHours / row.monthWorkingDays : 8;
    absenceDeduction = row.absenceDays * hoursPerDay * hourlyRate;
  }
  const deductions = Math.round((timeDeduction + absenceDeduction) * 100) / 100;

  const grossPay = Math.round((row.regularHours * hourlyRate + row.overtimeHours * overtimeRate) * 100) / 100;
  const insuranceDeduction = Math.round(grossPay * insurancePct / 100 * 100) / 100;
  const taxDeduction = Math.round(grossPay * taxPct / 100 * 100) / 100;
  const netPay = Math.round((grossPay - deductions - insuranceDeduction - taxDeduction) * 100) / 100;

  return {
    hourly_rate: hourlyRate,
    overtime_rate: overtimeRate,
    regular_hours: row.regularHours,
    overtime_hours: row.overtimeHours,
    bonuses: 0,
    deductions,
    insurance_deduction: insuranceDeduction,
    tax_deduction: taxDeduction,
    gross_pay: grossPay,
    net_pay: netPay
  };
}

function matchPerson(db, row) {
  const empNo = String(row.employeeNo || '').trim();
  const cardNo = String(row.cardNo || '').trim();
  if (empNo) {
    const byEmp = db.prepare('SELECT * FROM persons WHERE employee_no=?').get(empNo);
    if (byEmp) return byEmp;
  }
  if (cardNo) {
    const byCard = db.prepare('SELECT * FROM persons WHERE card_no=?').get(cardNo);
    if (byCard) return byCard;
  }
  const all = db.prepare('SELECT * FROM persons').all();
  const target = row.fullName;
  return all.find(p => normName(p.name) === target) || null;
}

module.exports = {
  COLUMNS,
  parseDuration,
  parseFarankenouText,
  parseFarankenouBuffer,
  calcPayrollFromAttendance,
  matchPerson,
  normName
};
