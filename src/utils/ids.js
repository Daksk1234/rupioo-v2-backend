import { customAlphabet } from "nanoid";
const id = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 10);
export const makeId = (prefix = "ID") => `${prefix}-${id()}`;
