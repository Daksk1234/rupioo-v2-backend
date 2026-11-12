// Short-lived cashier-to-accounts OTP display; never store the six digits in plaintext.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
const key=createHash('sha256').update(`RUPIOO_ACCOUNT_HANDOVER:${env.jwtSecret}`).digest();
export function sealHandoverOtp(value){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  const body=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
  return [iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),body.toString('base64url')].join('.');
}
export function unsealHandoverOtp(value){
  try{const [iv,tag,body]=String(value||'').split('.');if(!iv||!tag||!body)return '';
    const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));
    cipher.setAuthTag(Buffer.from(tag,'base64url'));
    return Buffer.concat([cipher.update(Buffer.from(body,'base64url')),cipher.final()]).toString('utf8');
  }catch{return '';}
}
