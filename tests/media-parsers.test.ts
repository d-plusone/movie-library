import { describe, expect, it } from "vitest";
import {
  parseBitrateValue,
  parseDurationValue,
  parseFrameRate,
} from "../src/utils/media-parsers";

describe("parseFrameRate", () => {
  it.each([
    ["30000/1001", 29.97],
    ["24000/1001", 23.98],
    ["30/1", 30],
    ["25/1", 25],
    ["29.97", 29.97],
    ["60", 60],
  ])("%s を %s fps に変換する", (input, expected) => {
    expect(parseFrameRate(input)).toBe(expected);
  });

  it("分母が 0 の場合は 0 を返す", () => {
    expect(parseFrameRate("30/0")).toBe(0);
  });

  it("未定義・空文字は 0 を返す", () => {
    expect(parseFrameRate(undefined)).toBe(0);
    expect(parseFrameRate("")).toBe(0);
  });

  it("数値にできない入力は 0 を返す", () => {
    expect(parseFrameRate("abc")).toBe(0);
    expect(parseFrameRate("N/A")).toBe(0);
  });
});

describe("parseDurationValue", () => {
  it("文字列の秒数を数値へ変換する", () => {
    expect(parseDurationValue("12.5")).toBe(12.5);
  });

  it("数値はそのまま返す", () => {
    expect(parseDurationValue(90)).toBe(90);
  });

  it("未定義・空文字・不正値は 0 を返す", () => {
    expect(parseDurationValue(undefined)).toBe(0);
    expect(parseDurationValue("")).toBe(0);
    expect(parseDurationValue("not-a-number")).toBe(0);
  });
});

describe("parseBitrateValue", () => {
  it("文字列のビットレートを整数へ変換する", () => {
    expect(parseBitrateValue("1234567")).toBe(1234567);
  });

  it("小数を含む文字列は整数部のみ解釈する", () => {
    expect(parseBitrateValue("123.9")).toBe(123);
  });

  it("数値はそのまま返す", () => {
    expect(parseBitrateValue(500000)).toBe(500000);
  });

  it("未定義・空文字・不正値は 0 を返す", () => {
    expect(parseBitrateValue(undefined)).toBe(0);
    expect(parseBitrateValue("")).toBe(0);
    expect(parseBitrateValue("abc")).toBe(0);
  });
});
