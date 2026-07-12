/*
 * ETH <-> wei unit conversion for the Detailed-mode converter popup on uint256
 * argument fields. Input is pre-validated here for friendly messages, then the
 * actual conversion is delegated to the QuantumCoin SDK (ethers v6-compatible
 * parseUnits/formatUnits).
 */

import { parseUnits as sdkParseUnits, formatUnits as sdkFormatUnits } from "./sdk";

/** Decimal coin amount (e.g. "1.5") -> integer wei string. Throws on bad input. */
export function parseUnits(value: string, decimals = 18): string {
  const text = value.trim();
  if (text === "") throw new Error("enter an amount");
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("expected a decimal number, e.g. 1.5");
  return sdkParseUnits(text, decimals);
}

/** Integer wei string -> trimmed decimal coin string (e.g. "1.5"). Throws on bad input. */
export function formatUnits(wei: string, decimals = 18): string {
  const text = wei.trim();
  if (text === "") throw new Error("enter a wei amount");
  if (!/^\d+$/.test(text)) throw new Error("expected a non-negative integer wei value");
  return sdkFormatUnits(text, decimals);
}
