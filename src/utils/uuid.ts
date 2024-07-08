import { nanoid } from "nanoid";

export const uuid = () => {
  return nanoid().replace(/-|_/g, "");
};
export const generateOrderId = () => {
  return "Nimbus-" + nanoid().substring(0, 20).replace(/-|_/g, "");
};
