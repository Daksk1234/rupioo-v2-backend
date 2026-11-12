import XLSX from 'xlsx';

const B2 = ['invoiceNo','invoiceDate','partyName','gstin','placeOfSupply','rate','taxableValue','cgst','sgst','igst','roundOff','grandTotal'];
const NOTE = ['recipientGSTIN','receiverName','noteNumber','noteDate','noteType','placeOfSupply','noteValue','rate','taxableValue'];
const PURCHASE = ['srNo','supplierGSTIN','supplierName','invoiceNo','invoiceDate','invoiceValue','taxableValue','placeOfSupply','reverseCharge','gstRate','igstAmount','cgstAmount','sgstAmount','roundOff','eligibleITC','reasonForIneligibility'];
const SUPPLY = ['label','taxableValue','integratedTax','centralTax','stateTax','cess'];
const HSN = ['HSN_Code','Product_Desc','uqc','qty','grandTotal','gstPercentage','taxableAmount','sgstAmt','cgstAmt','igstAmt','cessAmount'];
const IO = ['type','partyName','invoiceNo','date','invoiceValue','taxableValue','roundOff','cgstInput','sgstInput','igstInput','totalInput','cgstOutput','sgstOutput','igstOutput','totalOutput','availableGST'];
const TAX = ['totalTaxInput','totalTaxOut','BalanceTax'];
const labels = { invoiceNo:'Invoice No.', gstin:'GSTIN/UIN', recipientGSTIN:'GSTIN/UIN of Recipient', supplierGSTIN:'Supplier GSTIN', HSN_Code:'HSN', Product_Desc:'Description', uqc:'UQC', qty:'Total Quantity', gstPercentage:'Rate', gstRate:'GST Rate', cgst:'CGST', sgst:'SGST', igst:'IGST', cgstAmt:'CGST', sgstAmt:'SGST', igstAmt:'IGST', cgstAmount:'CGST', sgstAmount:'SGST', igstAmount:'IGST', eligibleITC:'Eligible ITC', label:'Details', BalanceTax:'Balance Tax' };
const label = key => labels[key] || key.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./, char => char.toUpperCase()).replace(/\b(cgst|sgst|igst)\b/gi, value => value.toUpperCase());
const value = input => input == null ? '' : input instanceof Date ? input.toISOString().slice(0,10) : input;

// Explicit columns keep internal IDs out of the export and retain headers for
// empty reports. Numbers remain numeric Excel cells, including negative amounts.
function appendReport(book, name, blocks, period) {
  const sheet = XLSX.utils.aoa_to_sheet([[name], ['Financial Year', period.financialYear, 'From', period.startDate, 'To', period.endDate]]);
  let row = 3;
  let maxColumns = 6;
  for (const [title, columns, rows = []] of blocks) {
    XLSX.utils.sheet_add_aoa(sheet, [[title], columns.map(label), ...rows.map(record => columns.map(key => value(record[key])))], {origin:{r:row,c:0}});
    if (!rows.length) XLSX.utils.sheet_add_aoa(sheet, [['No records for the selected period']], {origin:{r:row+2,c:0}});
    for (let index=0;index<rows.length;index++) {
      columns.forEach((key,column) => {
        const cell=sheet[XLSX.utils.encode_cell({r:row+2+index,c:column})];
        if (cell?.t==='n') cell.z=['srNo','qty'].includes(key)?'0.##':'#,##0.00;[Red]-#,##0.00';
      });
    }
    row += 2 + Math.max(1,rows.length) + 2;
    maxColumns = Math.max(maxColumns,columns.length);
  }
  sheet['!cols'] = Array.from({length:maxColumns},(_,index)=>({wch:index===2?30:22}));
  XLSX.utils.book_append_sheet(book,sheet,name);
}

export function createFullGstWorkbook({gstr1,gstr2b,gstr3b,hsn,inputOutput,tax},period) {
  const book=XLSX.utils.book_new();
  for (const category of ['B2B','B2CS','B2CL','CDNR','CDNUR']) {
    const columns=category==='CDNR'?NOTE:category==='CDNUR'?['urType',...NOTE.filter(key=>!['recipientGSTIN','receiverName'].includes(key))]:B2;
    appendReport(book,category,[[category,columns,gstr1.sections?.[category]||[]]],period);
  }
  appendReport(book,'GSTR2B',[['B2B Purchases',PURCHASE,gstr2b.rows]],period);
  appendReport(book,'GSTR3B',[
    ['3.1 Nature of Supplies',SUPPLY,gstr3b.natureOfSupplies],
    ['4. Eligible ITC',SUPPLY,gstr3b.eligibleITC],
  ],period);
  appendReport(book,'HSN Wise',[
    ['Regular',HSN,hsn.regular], ['Unregistered',HSN,hsn.unregister],
    ['HSN vs Sales Reconciliation',['metric','hsn','sales','difference'],['taxable','cgst','sgst','igst','roundOff','grand'].map(key=>{
      const hsnValue=Number(hsn.reconciliation?.hsn?.[key]||0),salesValue=Number(hsn.reconciliation?.sales?.[key]||0);
      return {metric:label(key),hsn:hsnValue,sales:salesValue,difference:Math.round((hsnValue-salesValue)*100)/100};
    })],
  ],period);
  appendReport(book,'GST Input Output',[['GST Input / Output',IO,inputOutput.rows]],period);
  appendReport(book,'Tax',[['Tax',TAX,tax.rows]],period);
  return book;
}
