import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { slipGroups, moneyWords } from './chequeDepositSlipRules.js';

// The clean, user-supplied SBI Assamese/English image is embedded as a STATIC
// background. The PDF overlays only data from the authenticated company's
// bank master and its validated, eligible received-cheque records.
// Source image: 1491 x 1055; trimmed to its printed area at y=150..925.
// Never use coordinates from the previous scanned-slip image here.
const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/sbi-clean-deposit-slip.png');
const FORM = Object.freeze({ width:1491, cropTop:150, pageX:10, pageY:79, pageWidth:822 });
const SCALE = FORM.pageWidth / FORM.width;
const p = (x, y) => ({ x:FORM.pageX + x * SCALE, y:FORM.pageY + (y-FORM.cropTop) * SCALE });
const clean = (v, limit=120) => String(v??'').replace(/[\r\n\t]/g,' ').trim().slice(0,limit);
const dec = (n) => Math.round((Number(n)||0)*100);
const rupees = (n) => Math.floor(dec(n)/100).toLocaleString('en-IN');
const paise = (n) => String(Math.abs(dec(n))%100).padStart(2,'0');
const formattedDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(clean(s)) ? `${s.slice(8,10)}/${s.slice(5,7)}/${s.slice(0,4)}` : '';

function printText(doc, value, x, y, widthPx, {size=8.5,minSize=5.5,bold=false,align='left'}={}) {
  const content=clean(value,240);
  if(!content)return;
  doc.font(bold?'Helvetica-Bold':'Helvetica').fontSize(size);
  const width=widthPx*SCALE;
  let fontSize=size;
  while(fontSize>minSize && doc.widthOfString(content)>width){fontSize-=0.25;doc.fontSize(fontSize);}
  const pt=p(x,y);
  doc.fontSize(fontSize).fillColor('#161616').text(content,pt.x,pt.y,{width,height:fontSize+3.2,align,ellipsis:true,lineBreak:false});
}
function boxes(doc,value,startX,y,step,count,option={}){
  const str=clean(value,50).replace(/\s+/g,'');
  // Do not silently truncate financial identifiers.
  if(str.length>count)throw Object.assign(new Error('Bank account number does not fit the deposit-slip account boxes'),{statusCode:422});
  [...str].forEach((ch,index)=>printText(doc,ch,startX+index*step,y,step,{size:7.9,minSize:7.3,align:'center',...option}));
}
function writeDate(doc,iso,areas){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(clean(iso)))return;
  const [yy,mm,dd]=iso.split('-');
  // The template prints "20" before the final two year digit boxes.
  [[dd,areas[0]],[mm,areas[1]],[yy.slice(-2),areas[2]]].forEach(([s,a])=>boxes(doc,s,a.x,a.y,a.step,2,{size:8.2}));
}
function splitWords(doc,value,widthA,widthB,size){
  const text=clean(value,240);const words=text.split(/\s+/),rows=['',''];
  doc.font('Helvetica').fontSize(size);
  for(const word of words){
    let i=rows[0]&&doc.widthOfString(`${rows[0]} ${word}`)>widthA*SCALE ? 1 : 0;
    if(i===1&&doc.widthOfString(`${rows[1]} ${word}`)>widthB*SCALE)return null;
    rows[i]=rows[i]?`${rows[i]} ${word}`:word;
  }
  return rows;
}
function amountWords(doc,amount,loc){
  const words=moneyWords(amount);
  let size=7.6,rows=null;
  while(size>=5.4 && !(rows=splitWords(doc,words,loc.w1,loc.w2,size))){size-=0.2;}
  if(!rows){rows=[words,''];size=5.3;}
  printText(doc,rows[0],loc.x1,loc.y1,loc.w1,{size,minSize:size});
  printText(doc,rows[1],loc.x2,loc.y2,loc.w2,{size,minSize:size});
}
function lineAmount(doc,amount,x,y,width=106){
  printText(doc,rupees(amount),x,y,width,{size:8.1,minSize:6.2,align:'right'});
  if(dec(amount)%100)printText(doc,paise(amount),x+width+4,y,24,{size:7.8,align:'center'});
}
function chequeAmount(doc, amount, y, copy){
  // The pay-in-slip CHEQUE table has one small box per rupee digit.
  // Place digits from the right edge, preserving the bank's existing boxes.
  const right=copy==='bank';
  const x=right?1288:333, step=right?25.8:23.2, slots=right?6:5;
  const whole=String(Math.floor(dec(amount)/100));
  if(whole.length<=slots){
    const gap=slots-whole.length;
    [...whole].forEach((digit,i)=>printText(doc,digit,x+(gap+i)*step,y,step,{size:7.5,minSize:7.1,align:'center'}));
  }else{
    // Some cheques exceed the form's fixed-width numeric grid; never drop digits.
    printText(doc,whole,x,y,step*slots,{size:6.2,minSize:5.2,align:'right'});
  }
  const p100=Math.abs(dec(amount))%100;
  if(p100){const start=right?1445:449;
    [...String(p100).padStart(2,'0')].forEach((digit,i)=>printText(doc,digit,start+i*14,y,14,{size:7,minSize:6.5,align:'center'}));
  }
}
function chequeDetail(c){
  const bank=clean(c.issuerBankName||'Bank',45);
  const branch=clean(c.issuerBranchName,30);
  return `${clean(c.chequeNo,24)}  ${formattedDate(c.chequeDate)}  ${bank}${branch?` / ${branch}`:''}`;
}
function drawPage(doc,bank,date,items,index,count){
  doc.addPage({size:'A4',layout:'landscape',margin:0});
  doc.image(TEMPLATE,FORM.pageX,FORM.pageY,{width:FORM.pageWidth});
  const subtotal=items.reduce((s,c)=>s+Number(c.amount||0),0);
  const holder=clean(bank.accountHolderName||'',85);
  const branch=clean(bank.branchName||'',70);
  const account=clean(bank.accountNumber,30).replace(/[\s-]/g,'');
  const telephone=clean(bank.phone||bank.contactNo||'',25);

  // Depositor copy, LEFT (not the central cash denomination panel).
  printText(doc,branch,115,281,124,{size:7.1,minSize:5.8});
  writeDate(doc,date,[{x:348,y:286,step:16.0},{x:394,y:286,step:16.0},{x:452,y:286,step:16}]);
  boxes(doc,account,19,376,23.1,20);
  printText(doc,holder,105,412,365,{size:9.0,minSize:6.0,bold:true});
  printText(doc,telephone,302,441,169,{size:7.4});
  lineAmount(doc,subtotal,137,506,162);
  amountWords(doc,subtotal,{x1:251,y1:546,w1:221,x2:17,y2:574,w2:456});

  // Bank copy, RIGHT (SBI labels are printed in the uploaded template).
  printText(doc,branch,1068,282,123,{size:7.1,minSize:5.8});
  writeDate(doc,date,[{x:1308,y:287,step:16.5},{x:1356,y:287,step:18.5},{x:1436,y:287,step:18.0}]);
  boxes(doc,account,960,376,25.8,20);
  printText(doc,holder,1047,415,423,{size:9.0,minSize:6.0,bold:true});
  printText(doc,telephone,1248,446,221,{size:7.4});
  amountWords(doc,subtotal,{x1:1188,y1:505,w1:283,x2:957,y2:548,w2:516});

  // The four blank CHEQUE lines on both copies; do not populate cash notes.
  for(let i=0;i<items.length;i++){
    const c=items[i], detail=chequeDetail(c);
    printText(doc,detail,21,675+i*28.1,305,{size:7.2,minSize:5.1});
    chequeAmount(doc,c.amount,675+i*28.1,'depositor');
    printText(doc,detail,960,636+i*27.3,353,{size:7.5,minSize:5.3});
    chequeAmount(doc,c.amount,636+i*27.3,'bank');
  }
  chequeAmount(doc,subtotal,789,'depositor');
  chequeAmount(doc,subtotal,748,'bank');

  // Outside the form: clearly distinguish this from a bank receipt.
  doc.font('Helvetica').fontSize(7.7).fillColor('#475569')
    .text(`Rupioo V2  |  Automatically prepared SBI deposit/pay-in slip  |  Sheet ${index+1} of ${count}`,
      15,44,{width:812,align:'center',lineBreak:false});
  doc.font('Helvetica').fontSize(7.3).fillColor('#475569')
    .text('Print at 100% / Actual size. Not proof of bank deposit or clearance. Check details and sign before submission.',
      15,536,{width:812,align:'center',lineBreak:false});
  doc.fillColor('#111111');
}
export function streamSbiDepositSlipPDF(res,{bank,depositDate,cheques}){
  const account=clean(bank?.accountNumber).replace(/[\s-]/g,'');
  if(!account||account.length>20)throw Object.assign(new Error('Company bank account number is missing or too long for this SBI template'),{statusCode:422});
  const groups=slipGroups(cheques,4);
  if(!groups.length)throw Object.assign(new Error('Select at least one eligible cheque'),{statusCode:422});
  if(groups.some(g=>g.some(c=>!Number.isFinite(Number(c.amount))||Number(c.amount)<=0)))throw new Error('Invalid selected cheque amount');
  const doc=new PDFDocument({autoFirstPage:false,compress:true,info:{Title:'Auto-filled SBI Assamese Cheque Deposit / Pay-in Slip',Author:'Rupioo V2 DMS',Subject:'Print preview only, not proof of bank deposit'}});
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`inline; filename="SBI_Cheque_Deposit_${depositDate.replaceAll('-','')}.pdf"`);
  res.setHeader('Cache-Control','private, no-store');
  doc.pipe(res);
  groups.forEach((group,i)=>drawPage(doc,bank,depositDate,group,i,groups.length));
  doc.end();
}
