#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════
  ROBUSTNESS VALIDATION — Polymarket BTC Up/Down 5-Minute Markets
  Out-of-sample stability, Drawdown analysis, Time-of-day segmentation.
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

# Frozen Spec
CONFIG_A = {"Direction": "UP",   "TRIGGER": 0.80, "MAX_BUY": 0.82, "SL": 0.45, "PL": 0.99, "name": "A (UP)"}
CONFIG_B = {"Direction": "DOWN", "TRIGGER": 0.80, "MAX_BUY": 0.84, "SL": 0.50, "PL": 0.99, "name": "B (DOWN)"}

CONFIGS = [CONFIG_A, CONFIG_B]

MARKET_WINDOW_SECONDS = 300
BUY_PRICE_BUFFER = 0.03
FALLING_KNIFE_DELTA = 0.10
FALLING_KNIFE_ROWS = 3
MAX_SPREAD = 0.05

def simulate_config(df: pd.DataFrame, config: dict) -> pd.DataFrame:
    direction = config["Direction"]
    trigger = config["TRIGGER"]
    max_buy = config["MAX_BUY"]
    sl_val = config["SL"]
    pl_val = config["PL"]
    
    ask_col = "ask_YES" if direction == "UP" else "ask_NO"
    bid_col = "bid_YES" if direction == "UP" else "bid_NO"
    winner_str = "Up" if direction == "UP" else "Down"
    
    trades = []
    market_groups = list(df.groupby("slug"))
    
    for slug, df_window in market_groups:
        df_window = df_window.reset_index(drop=True)
        winner_overall = df_window.iloc[0]["winner"]
        is_winner = bool(winner_overall == winner_str)
        start_time = df_window.iloc[0]["start_time"]
        
        entry_mask = (df_window[ask_col] >= trigger) & (df_window[ask_col] <= max_buy)
        if not entry_mask.any(): continue
        entry_idx = entry_mask.idxmax()
        
        signal_row = df_window.iloc[entry_idx]
        signal_price = signal_row[ask_col]
        entry_price = signal_price * (1 + BUY_PRICE_BUFFER)
        
        # Filters
        passed = True
        
        if entry_idx >= FALLING_KNIFE_ROWS:
            past_row = df_window.iloc[entry_idx - FALLING_KNIFE_ROWS]
            delta = signal_price - past_row[ask_col]
            if direction == "UP" and delta > FALLING_KNIFE_DELTA:
                passed = False
            elif direction == "DOWN" and delta < -FALLING_KNIFE_DELTA:
                passed = False
                
        if passed and (signal_price - signal_row[bid_col]) > MAX_SPREAD:
            passed = False
            
        # FAK Buffer Breach: conceptually entry > MAX_BUY + 0.02
        if passed and entry_price > max_buy + 0.02:
            passed = False
            
        if passed and signal_row[bid_col] <= sl_val:
            passed = False
            
        if not passed: continue
        
        # Exits
        df_future = df_window.iloc[entry_idx+1:]
        
        pl_mask = df_future[ask_col] >= pl_val
        sl_mask = df_future[ask_col] <= sl_val
        
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
            exit_pnl = pl_val - entry_price
            sub_type = "WIN_EARLY"
        elif exit_type == "SL":
            exit_pnl = sl_val - entry_price
            sub_type = "SL_FALSE_STOP" if is_winner else "SL_TRUE_CUT"
        else:
            if is_winner:
                exit_type = "RES_WIN"
                exit_pnl = 1.00 - entry_price
            else:
                exit_type = "RES_LOSS"
                exit_pnl = 0.00 - entry_price
                
        # Session classification
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


def print_markdown_table(headers, rows, title):
    print(f"\n{'='*100}")
    print(f"  {title}")
    print(f"{'='*100}\n")
    
    if not rows:
        print("  (no data)\n")
        return
        
    header_str = "| " + " | ".join(headers) + " |"
    sep_str = "| " + " | ".join("---" for _ in headers) + " |"
    
    print(header_str)
    print(sep_str)
    for row in rows:
        print("| " + " | ".join(str(r) for r in row) + " |")
    print()


def calculate_drawdown_and_streaks(pnl_series):
    cum_pnl = pnl_series.cumsum()
    peak = cum_pnl.cummax()
    drawdown = peak - cum_pnl
    
    max_dd = drawdown.max()
    max_equity = peak.max()
    
    # Drawdown % of Peak Equity (avoid div_zero)
    max_dd_pct = (max_dd / max_equity * 100) if max_equity > 0 else 100.0
    
    # Streaks
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


def format_pct(val):
    return f"{val:.2f}%"

def format_dollar(val):
    return f"${val:.4f}"

def format_dollar_2(val):
    return f"${val:.2f}"

def main():
    print("═" * 80)
    print("  ROBUSTNESS VALIDATION — Out-Of-Sample, Drawdown, & Sessions")
    print("═" * 80)
    
    print("\nLoading dataset...")
    df = pd.read_csv(DATASET_PATH)
    df = df.sort_values(["slug", "elapsed"]).reset_index(drop=True)
    
    results = {}
    for cfg in CONFIGS:
        print(f"Simulating Config {cfg['name']}...")
        results[cfg['name']] = simulate_config(df, cfg)
        
    print("\nGenerating Reports...\n")
    
    # ── FASE 1: TEMPORAL SPLIT ──
    t1_headers = ["Config", "Split", "n", "Exp PnL/Trade", "PL%", "SL%", "SL_FALSE%", "Flags"]
    t1_rows = []
    
    overfit_risks = {}
    out_sample_pnl_ok = {}
    
    for name, tdf in results.items():
        if tdf.empty: continue
        split_idx = int(len(tdf) * 0.7)
        in_sample = tdf.iloc[:split_idx]
        out_sample = tdf.iloc[split_idx:]
        
        # helper to process split
        def proc_split(sdf):
            n = len(sdf)
            if n == 0: return 0, 0, 0, 0
            exp_pnl = sdf["pnl"].mean()
            pl_pct = (sdf["exit_type"] == "PL").mean() * 100
            sl_pct = (sdf["exit_type"] == "SL").mean() * 100
            
            sl_tot = len(sdf[sdf["exit_type"] == "SL"])
            sl_false = len(sdf[sdf["sub_type"] == "SL_FALSE_STOP"])
            sl_false_pct = (sl_false / sl_tot * 100) if sl_tot > 0 else 0
            
            return n, exp_pnl, pl_pct, sl_pct, sl_false_pct
            
        n_in, pnl_in, pl_in, sl_in, sl_f_in = proc_split(in_sample)
        n_out, pnl_out, pl_out, sl_out, sl_f_out = proc_split(out_sample)
        
        delta = pnl_in - pnl_out
        flag = "⚠ OVERFIT RISK" if delta > 0.010 else "OK"
        overfit_risks[name] = (delta > 0.010)
        out_sample_pnl_ok[name] = (pnl_out > 0)
        
        t1_rows.append([
            name, "In-Sample", n_in, format_dollar(pnl_in), format_pct(pl_in), format_pct(sl_in), format_pct(sl_f_in), ""
        ])
        t1_rows.append([
            name, "Out-Sample", n_out, format_dollar(pnl_out), format_pct(pl_out), format_pct(sl_out), format_pct(sl_f_out), flag
        ])
        
    print_markdown_table(t1_headers, t1_rows, "TABEL 1 — TEMPORAL STABILITY")
    
    # ── FASE 2: DRAWDOWN & STREAKS ──
    t2_headers = ["Config", "Total PnL", "Max Drawdown", "Max DD %", "Max Loss Streak", "P90 Streak", "Streak≥5", "Streak≥10", "Recovery Factor"]
    t2_rows = []
    
    risk_checks = {}
    
    for name, tdf in results.items():
        if tdf.empty: continue
        
        total_pnl = tdf["pnl"].sum()
        max_dd, max_dd_pct, max_streak, p90_streak, str_5, str_10 = calculate_drawdown_and_streaks(tdf["pnl"])
        
        rec_factor = total_pnl / max_dd if max_dd > 0 else float('inf')
        
        # Keep metrics for decision matrix
        risk_checks[name] = {
            "dd_ok": max_dd_pct < 20.0,
            "rec_ok": rec_factor >= 2.0,
            "streak_ok": max_streak <= 10
        }
        
        t2_rows.append([
            name, format_dollar_2(total_pnl), format_dollar_2(max_dd), format_pct(max_dd_pct), 
            max_streak, int(p90_streak), str_5, str_10, f"{rec_factor:.2f}"
        ])
        
    print_markdown_table(t2_headers, t2_rows, "TABEL 2 — RISK PROFILE")
    
    # ── FASE 3: TIME-OF-DAY SEGMENTATION ──
    t3_headers = ["Config", "Session", "n", "Exp PnL/Trade", "SL_FALSE%", "Flag"]
    t3_rows = []
    
    session_ok = {}
    
    for name, tdf in results.items():
        if tdf.empty: continue
        
        prof_sessions = 0
        
        for sess in ["Asia", "London", "NY"]:
            sdf = tdf[tdf["session"] == sess]
            n = len(sdf)
            if n == 0: continue
            
            exp_pnl = sdf["pnl"].mean()
            sl_tot = len(sdf[sdf["exit_type"] == "SL"])
            sl_false = len(sdf[sdf["sub_type"] == "SL_FALSE_STOP"])
            sl_false_pct = (sl_false / sl_tot * 100) if sl_tot > 0 else 0
            
            flag = "⚠ AVOID THIS SESSION" if exp_pnl < 0 else "OK"
            if exp_pnl > 0:
                prof_sessions += 1
                
            t3_rows.append([
                name, sess, n, format_dollar(exp_pnl), format_pct(sl_false_pct), flag
            ])
            
        session_ok[name] = (prof_sessions >= 2)
        
    print_markdown_table(t3_headers, t3_rows, "TABEL 3 — SESSION PERFORMANCE")
    
    # ── FASE 4: DECISION MATRIX ──
    print(f"\n{'='*100}")
    print("  FASE 4 — GO / NO-GO DECISION MATRIX")
    print(f"{'='*100}\n")
    
    print("  ┌──────────────────────────────────────┬──────────┬──────────┐")
    print("  │ Kriteria                             │ Config A │ Config B │")
    print("  ├──────────────────────────────────────┼──────────┼──────────┤")
    
    def yn(cond): return "YES     " if cond else "NO      "
    
    c_a = "A (UP)"
    c_b = "B (DOWN)"
    
    checks_list = [
        ("Out-of-sample PnL positif?", lambda c: out_sample_pnl_ok.get(c, False)),
        ("Overfit flag triggered?", lambda c: overfit_risks.get(c, True)), # Warning: YES is bad here!
        ("Max Drawdown < 20% equity?", lambda c: risk_checks.get(c, {}).get("dd_ok", False)),
        ("Recovery Factor ≥ 2.0?", lambda c: risk_checks.get(c, {}).get("rec_ok", False)),
        ("Max loss streak ≤ 10?", lambda c: risk_checks.get(c, {}).get("streak_ok", False)),
        ("Setidaknya 2 sesi menguntungkan?", lambda c: session_ok.get(c, False))
    ]
    
    verdicts = {c_a: [], c_b: []}
    
    for desc, func in checks_list:
        a_res = func(c_a)
        b_res = func(c_b)
        
        # logic for YES/NO text
        a_text = yn(a_res)
        b_text = yn(b_res)
        
        print(f"  │ {desc:<36} │ {a_text.strip():<8} │ {b_text.strip():<8} │")
        
        # Accumulate pass/fail. Note: Overfit triggered == False is PASS.
        a_pass = not a_res if "Overfit" in desc else a_res
        b_pass = not b_res if "Overfit" in desc else b_res
        
        verdicts[c_a].append((desc, a_pass))
        verdicts[c_b].append((desc, b_pass))
        
    print("  ├──────────────────────────────────────┼──────────┼──────────┤")
    
    final_verdict = {}
    for c in [c_a, c_b]:
        fails = [desc for desc, passed in verdicts[c] if not passed]
        if not fails:
            final_verdict[c] = "GO"
        elif len(fails) <= 2:
            final_verdict[c] = "WAIT"
        else:
            final_verdict[c] = "STOP"
            
    print(f"  │ VERDICT                              │ {final_verdict[c_a]:<8} │ {final_verdict[c_b]:<8} │")
    print("  └──────────────────────────────────────┴──────────┴──────────┘\n")
    
    # Diagnostics
    for c in [c_a, c_b]:
        if final_verdict[c] in ["WAIT", "STOP"]:
            fails = [desc for desc, passed in verdicts[c] if not passed]
            print(f"  [Diagnosis {c}]")
            if final_verdict[c] == "WAIT":
                print(f"    Perbaiki kriteria yang gagal: {', '.join(fails)}")
                print(f"    Tweak SL margin slightly or restrict to best performing session to boost recovery.\n")
            else:
                print(f"    Konfigurasi tidak layak produksi. Gagal di {len(fails)} kriteria: {', '.join(fails)}")
                print("    Risk of ruin is too high; model requires architectural reconsideration.\n")

if __name__ == "__main__":
    main()
