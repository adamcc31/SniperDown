#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════
  CONFIG A SESSION FIX — Polymarket BTC Up/Down
  Sesi NY Isolation, Deep Dive Anatomy, and Final Deployment Specs.
═══════════════════════════════════════════════════════════════════════
"""

import pandas as pd
import numpy as np
import os
import sys
import datetime

# ─── CONFIG ─────────────────────────────────────────────────────────
DATASET_PATH = os.path.join(
    os.path.dirname(__file__), "..", "dataset",
    "market_data_2sec_weekly5_with_resolutions.csv"
)

# Config B Data (Hardcoded based on the known state)
CONFIG_B_STATS = {
    "Direction": "DOWN", 
    "BUY_TRIGGER": 0.80, 
    "MAX_BUY": 0.84, 
    "SL": 0.50,
    "Expected PnL/Trade": 0.0424,
    "Recovery Factor": 8.10,
    "Max Drawdown": "12.1%",
    "OOS PnL/Trade": 0.0662
}

# Config A Frozen Spec
DIRECTION = "UP"
TRIGGER = 0.80
MAX_BUY = 0.82
SL_VAL = 0.45
PL_VAL = 0.99

MARKET_WINDOW_SECONDS = 300
BUY_PRICE_BUFFER = 0.03
FALLING_KNIFE_DELTA = 0.10
FALLING_KNIFE_ROWS = 3
MAX_SPREAD = 0.05

def calculate_drawdown_and_streaks(pnl_series):
    cum_pnl = pnl_series.cumsum()
    peak = cum_pnl.cummax()
    drawdown = peak - cum_pnl
    
    max_dd = drawdown.max()
    max_equity = peak.max()
    
    max_dd_pct = (max_dd / max_equity * 100) if max_equity > 0 else 100.0
    
    is_loss = pnl_series < 0
    streak = 0
    streaks = []
    for loss in is_loss:
        if loss:
            streak += 1
        else:
            if streak > 0:
                streaks.append(streak)
            streak = 0
    if streak > 0:
        streaks.append(streak)
        
    if not streaks:
        return max_dd, max_dd_pct, 0, 0, 0, 0
    
    max_streak = max(streaks)
    p90_streak = np.percentile(streaks, 90)
    streak_geq_5 = sum(1 for s in streaks if s >= 5)
    streak_geq_10 = sum(1 for s in streaks if s >= 10)
    
    return max_dd, max_dd_pct, max_streak, p90_streak, streak_geq_5, streak_geq_10

def simulate_config_a(df: pd.DataFrame, sl_override=None) -> pd.DataFrame:
    ask_col = "ask_YES"
    bid_col = "bid_YES"
    sl_target = sl_override if sl_override is not None else SL_VAL
    
    trades = []
    market_groups = list(df.groupby("slug"))
    
    for slug, df_window in market_groups:
        df_window = df_window.reset_index(drop=True)
        winner_overall = df_window.iloc[0]["winner"]
        is_winner = bool(winner_overall == "Up")
        start_time = df_window.iloc[0]["start_time"]
        
        entry_mask = (df_window[ask_col] >= TRIGGER) & (df_window[ask_col] <= MAX_BUY)
        if not entry_mask.any(): continue
        entry_idx = entry_mask.idxmax()
        
        signal_row = df_window.iloc[entry_idx]
        signal_price = signal_row[ask_col]
        entry_price = signal_price * (1 + BUY_PRICE_BUFFER)
        
        passed = True
        
        if entry_idx >= FALLING_KNIFE_ROWS:
            past_row = df_window.iloc[entry_idx - FALLING_KNIFE_ROWS]
            delta = signal_price - past_row[ask_col]
            if delta > FALLING_KNIFE_DELTA:
                passed = False
                
        if passed and (signal_price - signal_row[bid_col]) > MAX_SPREAD:
            passed = False
            
        if passed and entry_price > MAX_BUY + 0.02:
            passed = False
            
        if passed and signal_row[bid_col] <= sl_target:
            passed = False
            
        if not passed: continue
        
        df_future = df_window.iloc[entry_idx+1:]
        
        pl_mask = df_future[ask_col] >= PL_VAL
        sl_mask = df_future[ask_col] <= sl_target
        
        pl_idx = pl_mask.idxmax() if pl_mask.any() else None
        sl_idx = sl_mask.idxmax() if sl_mask.any() else None
        
        if pl_idx is not None and sl_idx is not None:
            exit_type = "PL" if pl_idx <= sl_idx else "SL"
        elif pl_idx is not None:
            exit_type = "PL"
        elif sl_idx is not None:
            exit_type = "SL"
        else:
            exit_type = "RES"
            
        sub_type = None
        if exit_type == "PL":
            exit_pnl = PL_VAL - entry_price
            sub_type = "WIN_EARLY"
        elif exit_type == "SL":
            exit_pnl = sl_target - entry_price
            sub_type = "SL_FALSE_STOP" if is_winner else "SL_TRUE_CUT"
        else:
            if is_winner:
                exit_type = "RES_WIN"
                exit_pnl = 1.00 - entry_price
            else:
                exit_type = "RES_LOSS"
                exit_pnl = 0.00 - entry_price
                
        entry_timestamp = start_time + signal_row["elapsed"]
        hour = datetime.datetime.utcfromtimestamp(entry_timestamp).hour
        if 0 <= hour < 8:
            session = "Asia"
        elif 8 <= hour < 16:
            session = "London"
        else:
            session = "NY"
            
        trades.append({
            "market": slug,
            "entry_time": entry_timestamp,
            "session": session,
            "exit_type": exit_type,
            "sub_type": sub_type,
            "pnl": exit_pnl
        })
        
    trades_df = pd.DataFrame(trades)
    if not trades_df.empty:
        trades_df = trades_df.sort_values("entry_time").reset_index(drop=True)
    return trades_df

def format_pct(val):
    return f"{val:.2f}%"

def format_dollar(val):
    return f"${val:.4f}"

def format_dollar_2(val):
    return f"${val:.2f}"

def print_markdown_table(headers, rows, title):
    print(f"\n{'='*100}")
    print(f"  {title}")
    print(f"{'='*100}\n")
    if not rows:
        print("  (no data)\n")
        return
    print("| " + " | ".join(headers) + " |")
    print("| " + " | ".join("---" for _ in headers) + " |")
    for row in rows:
        print("| " + " | ".join(str(r) for r in row) + " |")
    print()

def proc_split(sdf):
    n = len(sdf)
    if n == 0: return 0, 0, 0, 0, 0
    exp_pnl = sdf["pnl"].mean()
    pl_pct = (sdf["exit_type"] == "PL").mean() * 100
    sl_pct = (sdf["exit_type"] == "SL").mean() * 100
    sl_tot = len(sdf[sdf["exit_type"] == "SL"])
    sl_false = len(sdf[sdf["sub_type"] == "SL_FALSE_STOP"])
    sl_false_pct = (sl_false / sl_tot * 100) if sl_tot > 0 else 0
    return n, exp_pnl, pl_pct, sl_pct, sl_false_pct

def main():
    print("═" * 80)
    print("  TASK 1 — CONFIG A SESSION ISOLATION FIX")
    print("═" * 80)
    
    df = pd.read_csv(DATASET_PATH)
    df = df.sort_values(["slug", "elapsed"]).reset_index(drop=True)
    
    tdf_all = simulate_config_a(df)
    
    # ── LANGKAH 1 — VERIFIKASI BASELINE SESSION SPLIT ──
    t1_headers = ["Session", "n", "Exp PnL/Trade", "Max Drawdown", "Recovery Factor", "SL_FALSE%"]
    t1_rows = []
    
    for sess in ["Asia", "London", "NY"]:
        sdf = tdf_all[tdf_all["session"] == sess]
        n, pnl, _, sl_pct, sl_false_pct = proc_split(sdf)
        
        if n > 0:
            max_dd, max_dd_pct, *_ = calculate_drawdown_and_streaks(sdf["pnl"])
            total_pnl = sdf["pnl"].sum()
            rec_factor = total_pnl / max_dd if max_dd > 0 else float('inf')
            t1_rows.append([sess, n, format_dollar(pnl), format_dollar_2(max_dd), f"{rec_factor:.2f}", format_pct(sl_false_pct)])
            
    print_markdown_table(t1_headers, t1_rows, "TABEL 1 — BASELINE SESSION SPLIT")
    
    # ── LANGKAH 2 — CONFIG A (NON-NY ONLY) ──
    tdf_non_ny = tdf_all[tdf_all["session"] != "NY"].reset_index(drop=True)
    
    n_non_ny = len(tdf_non_ny)
    exp_pnl_non_ny = tdf_non_ny["pnl"].mean() if n_non_ny > 0 else 0
    total_pnl_non_ny = tdf_non_ny["pnl"].sum() if n_non_ny > 0 else 0
    
    max_dd_n, max_dd_pct_n, max_streak_n, *_ = calculate_drawdown_and_streaks(tdf_non_ny["pnl"]) if n_non_ny > 0 else (0, 0, 0, 0, 0, 0)
    rec_factor_n = total_pnl_non_ny / max_dd_n if max_dd_n > 0 else float('inf')
    
    split_idx = int(n_non_ny * 0.7)
    in_sample = tdf_non_ny.iloc[:split_idx]
    out_sample = tdf_non_ny.iloc[split_idx:]
    
    _, pnl_in_n, _, _, _ = proc_split(in_sample)
    _, pnl_out_n, _, _, _ = proc_split(out_sample)
    
    delta_n = pnl_in_n - pnl_out_n
    overfit_flag_n = (delta_n > 0.010)
    
    session_profit_count_n = 0
    for sess in ["Asia", "London"]:
        if len(tdf_non_ny[tdf_non_ny["session"] == sess]) > 0 and tdf_non_ny[tdf_non_ny["session"] == sess]["pnl"].mean() > 0:
            session_profit_count_n += 1
            
    # Decision Matrix checks
    oos_pk = pnl_out_n > 0
    dd_pk = max_dd_pct_n < 20.0
    rec_pk = rec_factor_n >= 2.0
    streak_pk = max_streak_n <= 10
    sess_pk = session_profit_count_n >= 1
    
    checks = [
        ("Out-of-sample PnL positif?", oos_pk),
        ("Overfit flag triggered?", overfit_flag_n), # YES is BAD
        ("Max Drawdown < 20% equity?", dd_pk),
        ("Recovery Factor >= 2.0?", rec_pk),
        ("Max loss streak <= 10?", streak_pk),
        ("Setidaknya 1 sesi menguntungkan?", sess_pk)
    ]
    
    print("  ┌──────────────────────────────────────┬────────────────────────┐")
    print("  │ Kriteria                             │ Config A (Asia+London) │")
    print("  ├──────────────────────────────────────┼────────────────────────┤")
    
    verdict_fails = []
    for desc, res in checks:
        text = "YES" if res else "NO"
        print(f"  │ {desc:<36} │ {text:<22} │")
        if "Overfit" in desc:
            if res: verdict_fails.append(desc)
        else:
            if not res: verdict_fails.append(desc)
            
    print("  ├──────────────────────────────────────┼────────────────────────┤")
    
    if len(verdict_fails) == 0:
        a_verdict = "GO"
    elif len(verdict_fails) <= 2:
        a_verdict = "WAIT"
    else:
        a_verdict = "STOP"
        
    print(f"  │ VERDICT                              │ {a_verdict:<22} │")
    print("  └──────────────────────────────────────┴────────────────────────┘")
    
    if a_verdict in ["WAIT", "STOP"]:
        print(f"\n  [Diagnosis Config A (Asia+London)]")
        if a_verdict == "WAIT":
            print(f"    Perbaiki: {', '.join(verdict_fails)}")
            print("    Tweak SL margin slightly or restrict to best performing session to boost recovery.")
        else:
            print("    Config A tidak viable bahkan tanpa NY")
            
    # ── TASK 2: NY SESSION DEEP DIVE ──
    print(f"\n\n{'='*100}")
    print("  TASK 2 — NY SESSION DEEP DIVE")
    print(f"{'='*100}\n")
    
    if a_verdict in ["GO", "WAIT"]:
        tdf_ny = tdf_all[tdf_all["session"] == "NY"]
        n_ny = len(tdf_ny)
        if n_ny > 0:
            total_sl = len(tdf_ny[tdf_ny["exit_type"] == "SL"])
            sl_pct = total_sl / n_ny * 100
            
            sl_false_count = len(tdf_ny[tdf_ny["sub_type"] == "SL_FALSE_STOP"])
            sl_false_pct_anat = (sl_false_count / total_sl * 100) if total_sl > 0 else 0
            
            res_loss_count = len(tdf_ny[tdf_ny["exit_type"] == "RES_LOSS"])
            res_loss_pct = (res_loss_count / n_ny * 100)
            
            pl_count = len(tdf_ny[tdf_ny["exit_type"] == "PL"])
            pl_pct = (pl_count / n_ny * 100)
            
            print("  --- NY LOSS ANATOMY ---")
            print(f"  Total Trades (NY) : {n_ny}")
            print(f"  1. Exit via SL    : {sl_pct:.2f}%")
            print(f"  2. SL_FALSE_STOP  : {sl_false_pct_anat:.2f}% (dari total SL)")
            print(f"  3. RES_LOSS       : {res_loss_pct:.2f}% (kalah di resolusi)")
            print(f"  4. Profit Lock    : {pl_pct:.2f}%\n")
            
            needs_sl_sweep = False
            if sl_false_pct_anat > 60:
                print("  Interpretasi: SL_FALSE_STOP ekstrim tinggi (>60%). Masalah pada whipsaw predatorial.")
                print("  Solusi      : Menurunkan SL ke level support yang lebih rendah.\n")
                needs_sl_sweep = True
            elif res_loss_count > (0.5 * n_ny): # RES_LOSS > 50%
                print("  Interpretasi: RES_LOSS terlalu tinggi. Masalah dominan ada di prediksi awal/direction loss.")
                print("  Solusi      : NY harus diexclude secara permanen karena lack of structural edge.\n")
            else:
                print("  Interpretasi: Mix of factors. SL whipsaw is not conclusively the single root cause.")
                print("  Solusi      : NY diexclude dari produksi.\n")
                
            if needs_sl_sweep:
                print("  --- NY SL MICRO-SWEEP ---")
                sl_candidates = [0.35, 0.38, 0.40, 0.42]
                t2_rows = []
                best_ny_sl = None
                best_ny_pnl = -999
                
                for sl_val in sl_candidates:
                    tdf_ny_sweep = simulate_config_a(df, sl_override=sl_val)
                    tdf_ny_sweep = tdf_ny_sweep[tdf_ny_sweep["session"] == "NY"]
                    
                    ns = len(tdf_ny_sweep)
                    if ns > 0:
                        swe_pnl = tdf_ny_sweep["pnl"].mean()
                        max_dd_swe, *_ = calculate_drawdown_and_streaks(tdf_ny_sweep["pnl"])
                        tot_swe = tdf_ny_sweep["pnl"].sum()
                        swe_rec = (tot_swe / max_dd_swe) if max_dd_swe > 0 else float('inf')
                        
                        swe_sl_tot = len(tdf_ny_sweep[tdf_ny_sweep["exit_type"] == "SL"])
                        swe_sl_f = len(tdf_ny_sweep[tdf_ny_sweep["sub_type"] == "SL_FALSE_STOP"])
                        swe_sl_f_pct = (swe_sl_f / swe_sl_tot * 100) if swe_sl_tot > 0 else 0
                        
                        t2_rows.append([sl_val, ns, format_dollar(swe_pnl), f"{swe_rec:.2f}", format_pct(swe_sl_f_pct)])
                        
                        if swe_pnl >= -0.005 and swe_pnl > best_ny_pnl:
                            best_ny_sl = sl_val
                            best_ny_pnl = swe_pnl
                            
                print_markdown_table(["SL (NY)", "n", "Exp PnL/Trade", "Recovery Factor", "SL_FALSE%"], t2_rows, "TABEL 2 — NY SL MICRO-SWEEP")
                
                if best_ny_sl is None:
                    print("  Konfirmasi: Tidak ada margin SL yang mencapai batas toleransi minimal (-$0.005).")
                    print("              Sesi NY diexclude secara permanen.\n")
                else:
                    print(f"  Konfirmasi: SL={best_ny_sl} berhasil menyelamatkan PnL hingga menembus batas toleransi.\n")
        else:
            print("  Tidak ada data transaksi di sesi NY.")
    else:
        print("  Config A gagal. Deep dive NY diabaikan.")

    # ── TASK 3: FINAL PRODUCTION DEPLOYMENT SPEC ──
    print(f"\n{'='*100}")
    print("  TASK 3 — FINAL PRODUCTION DEPLOYMENT SPEC")
    print(f"{'='*100}\n")
    
    # Always print Config B as it's structurally fully viable.
    print("  ┌─────────────────────────────────────────────────────────┐")
    print("  │  CONFIG B — DOWN — Active: 24/7 (00:00-23:59 UTC)       │")
    print("  │                                                         │")
    print(f"  │  BUY_TRIGGER_PRICE={CONFIG_B_STATS['BUY_TRIGGER']:.2f}                                 │")
    print(f"  │  MAX_BUY_PRICE={CONFIG_B_STATS['MAX_BUY']:.2f}                                     │")
    print(f"  │  PROFIT_LOCK_PRICE=0.99                                 │")
    print(f"  │  STOP_LOSS_PRICE={CONFIG_B_STATS['SL']:.2f}                                   │")
    print("  │                                                         │")
    print(f"  │  Expected PnL/Trade : ${CONFIG_B_STATS['Expected PnL/Trade']:.4f}                           │")
    print(f"  │  Recovery Factor    : {CONFIG_B_STATS['Recovery Factor']:.2f}                              │")
    print(f"  │  Max Drawdown       : {CONFIG_B_STATS['Max Drawdown']:<32}│")
    print(f"  │  OOS PnL/Trade      : ${CONFIG_B_STATS['OOS PnL/Trade']:.4f}                           │")
    print("  └─────────────────────────────────────────────────────────┘\n")
    
    if a_verdict == "GO":
        # Print Config A parameters for non-NY
        print("  ┌─────────────────────────────────────────────────────────┐")
        print("  │  CONFIG A — UP — Active: Asia & London (00:00-15:59 UTC)│")
        print("  │                                                         │")
        print(f"  │  BUY_TRIGGER_PRICE={TRIGGER:.2f}                                 │")
        print(f"  │  MAX_BUY_PRICE={MAX_BUY:.2f}                                     │")
        print(f"  │  PROFIT_LOCK_PRICE={PL_VAL:.2f}                                 │")
        print(f"  │  STOP_LOSS_PRICE={SL_VAL:.2f}                                   │")
        print("  │                                                         │")
        print(f"  │  Expected PnL/Trade : {format_dollar(exp_pnl_non_ny):<32}│")
        print(f"  │  Recovery Factor    : {rec_factor_n:<32.2f}│")
        print(f"  │  Max Drawdown       : {format_pct(max_dd_pct_n):<32}│")
        print(f"  │  OOS PnL/Trade      : {format_dollar(pnl_out_n):<32}│")
        print("  │  ACTIVE_HOURS_UTC   = 00:00–15:59                       │")
        print("  └─────────────────────────────────────────────────────────┘\n")
    else:
        print("  [INFO] CONFIG A dihentikan karena tetap tidak melampaui GO matrix, bahkan dengan eksklusi NY.")
        print("         Config B berjalan solo.\n")

if __name__ == "__main__":
    main()
