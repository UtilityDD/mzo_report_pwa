/**
 * Display-only count for selected materials stocked in MT.
 * 1 MT = 1000 kg; count is always a non-negative integer (floor).
 * Unit of the calculated number: "no."
 */
(function (global) {
  'use strict';

  const KG_PER_NO = {
    '0110020711': 676,
    '0110051311': 396
  };

  function kgPerNo(materialCode) {
    const raw = String(materialCode == null ? '' : materialCode).trim();
    if (!raw) return null;
    if (KG_PER_NO[raw] != null) return KG_PER_NO[raw];
    const keys = Object.keys(KG_PER_NO);
    for (let i = 0; i < keys.length; i++) {
      if (Number(keys[i]) === Number(raw)) return KG_PER_NO[keys[i]];
    }
    return null;
  }

  function stockMtToNo(materialCode, stockMt) {
    const kg = kgPerNo(materialCode);
    if (kg == null) return null;
    const mt = Number(stockMt);
    if (!Number.isFinite(mt) || mt <= 0) return 0;
    return Math.floor((mt * 1000) / kg);
  }

  function formatStockNumber(stockMt, opts) {
    const mt = Number(stockMt);
    if (!Number.isFinite(mt)) return String(stockMt ?? '');
    const min = opts && opts.minimumFractionDigits != null ? opts.minimumFractionDigits : 0;
    const max = opts && opts.maximumFractionDigits != null ? opts.maximumFractionDigits : 3;
    return mt.toLocaleString(undefined, {
      minimumFractionDigits: min,
      maximumFractionDigits: max
    });
  }

  /** e.g. "2.05 (3 no.)" */
  function formatStockWithNo(materialCode, stockMt, opts) {
    const stockText = formatStockNumber(stockMt, opts);
    const count = stockMtToNo(materialCode, stockMt);
    if (count == null) return stockText;
    return stockText + ' (' + count.toLocaleString(undefined) + ' no.)';
  }

  global.MzoStockPoleCount = {
    KG_PER_NO,
    kgPerNo,
    stockMtToNo,
    formatStockNumber,
    formatStockWithNo
  };
})(typeof window !== 'undefined' ? window : globalThis);
