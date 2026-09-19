import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail } from "../utils/http.js";
import { createOtp, verifyOtp } from "../services/otpService.js";
const router=express.Router();router.use(requireAuth);
router.post("/create",async(req,res)=>{if(!req.auth.addons?.otp && req.auth.role!=="MASTER")return fail(res,"Internal OTP add-on is not enabled for this plan",403);const result=await createOtp({tenantKey:req.auth.tenantKey,...req.body});ok(res,{...result,devCode:process.env.NODE_ENV==="production"?undefined:result.code},"OTP created");});
router.post("/verify",async(req,res)=>{const result=await verifyOtp(req.body);if(!result.ok)return fail(res,result.reason,400);ok(res,{verified:true,actionType:result.challenge.actionType,transactionId:result.challenge.transactionId},"OTP verified");});
export default router;
