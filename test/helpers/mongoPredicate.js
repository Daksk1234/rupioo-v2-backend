// Evaluate the small Mongo expression subset used by read-only route fixtures.
// This keeps territory tests exercising the actual emitted query, including
// normalized legacy fields and the interaction with a customer-name search.
const equal=(a,b)=>String(a??'')===String(b??'');
const field=(value,path)=>path.split('.').reduce((row,key)=>row?.[key],value);
function expression(value,row,variables={}){
 if(typeof value==='string'&&value.startsWith('$$')){const [name,...path]=value.slice(2).split('.');return path.length?field(variables[name],path.join('.')):variables[name];}
 if(typeof value==='string'&&value.startsWith('$'))return field(row,value.slice(1));
 if(Array.isArray(value))return value.map(item=>expression(item,row,variables));
 if(!value||typeof value!=='object')return value;
 const [op,input]=Object.entries(value)[0];const run=v=>expression(v,row,variables);
 if(op==='$trim')return String(run(input.input)??'').trim();
 if(op==='$convert')return run(input.input)==null?input.onNull:String(run(input.input));
 if(op==='$isArray')return Array.isArray(run(input));
 if(op==='$size')return run(input).length;
 if(op==='$gt'){const [a,b]=run(input);return a>b;}
 if(op==='$cond')return run(input[0])?run(input[1]):run(input[2]);
 if(op==='$map')return run(input.input).map(item=>expression(input.in,row,{...variables,[input.as]:item}));
 if(op==='$filter')return run(input.input).filter(item=>expression(input.cond,row,{...variables,[input.as]:item}));
 if(op==='$regexMatch')return new RegExp(input.regex).test(run(input.input));
 if(op==='$setIntersection'){const [a,b]=run(input);return [...new Set(a)].filter(item=>b.includes(item));}
 throw new Error(`Unhandled test expression ${op}`);
}
export function matchesMongo(row,filter){return Object.entries(filter).every(([key,value])=>{
 if(key==='$or')return value.some(part=>matchesMongo(row,part));
 if(key==='$and')return value.every(part=>matchesMongo(row,part));
 if(key==='$expr')return expression(value,row);
 const actual=key==='addresses.pincode'?(row.addresses||[]).map(address=>address.pincode):field(row,key);
 if(value instanceof RegExp)return value.test(String(actual??''));
 if(value&&typeof value==='object'&&!(value instanceof Date))return Object.entries(value).every(([op,expected])=>{
  if(op==='$in')return expected.some(item=>Array.isArray(actual)?actual.some(v=>equal(v,item)):equal(actual,item));
  if(op==='$nin')return !expected.some(item=>equal(actual,item));
  if(op==='$ne')return !equal(actual,expected);
  if(op==='$exists')return (actual!==undefined)===expected;
  if(op==='$gte')return actual>=expected;if(op==='$gt')return actual>expected;if(op==='$lt')return actual<expected;
  throw new Error(`Unhandled test query ${op}`);
 });
 return equal(actual,value);
});}
