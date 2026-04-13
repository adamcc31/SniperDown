#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════
  RANGE SWEEP OPTIMIZATION — Polymarket BTC Up/Down (Phase 2 Refinement)
  Fine-Grained SL Sweep & Asymmetric Entry Band Analysis.
═══════════════════════════════════════════════════════════════════════
"""

import pandas as pd
import numpy as np
import os
import sys

# ─── CONFIG ─────────────────────────────────────────────────────────
DATASET_PATH = os.path.join(
    os.path.dirname(__file__), "..", "dataset",
    "market_data_2sec_weekly5_with_resolutions.csv"
)

# Phase 1 Config
PHASE1_THRESHOLDS = [0.80, 0.85, 0.90, 0.95]
PHASE1_SL_VALS = [0.42, 0.45, 0.47, 0.50, 0.52, 0.55]

# Phase 2 Config
PHASE2_TRIGGERS = [0.80, 0.85, 0.90, 0.95]
PHASE2_DELTAS = [0.02, 0.04, 0.06]
PHASE2_SL_VALS = [0.47, 0.50, 0.52]

DIRECTIONS = ["UP", "DOWN"]

MARKET_WINDOW_SECONDS = 300
BUY_PRICE_BUFFER = 0.03
MAX_BUY_BUFFER = 0.02
PROFIT_LOCK_PRICE = 0.99

# Filters
FALLING_KNIFE_DELTA = 0.10
FALLING_KNIFE_ROWS = 3
MAX_SPREAD = 0.05

def classify_ttr(ttr_seconds: float) -> str:
    if ttr_seconds > 210:
        return "Early"
    elif ttr_seconds >= 90:
        return "Mid"
    else:
        return "Late"

def determine_exit(pl_idx, sl_idx, entry_price, sl_val, is_winner):
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
        exit_pnl = PROFIT_LOCK_PRICE - entry_price
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
    return exit_type, exit_pnl, sub_type

def simulate_markets(df: pd.DataFrame):
    p1_trades = []
    p2_trades = []
    
    market_groups = list(df.groupby("slug"))
    total_markets = len(market_groups)
    
    for idx, (slug, df_window) in enumerate(market_groups):
        if idx % 100 == 0:
            sys.stdout.write(f"\r  Processing market {idx}/{total_markets}...")
            sys.stdout.flush()
            
        df_window = df_window.reset_index(drop=True)
        winner_overall = df_window.iloc[0]["winner"]
        
        for direction in DIRECTIONS:
            ask_col = "ask_YES" if direction == "UP" else "ask_NO"
            bid_col = "bid_YES" if direction == "UP" else "bid_NO"
            is_winner = bool(winner_overall == ("Up" if direction == "UP" else "Down"))
            
            # --- PHASE 1 ---
            for threshold in PHASE1_THRESHOLDS:
                entry_mask = df_window[ask_col] <= threshold
                if not entry_mask.any(): continue
                entry_idx = entry_mask.idxmax()
                
                signal_row = df_window.iloc[entry_idx]
                signal_price = signal_row[ask_col]
                entry_price = signal_price * (1 + BUY_PRICE_BUFFER)
                
                # F1, F2, F3
                passed = True
                if entry_idx >= FALLING_KNIFE_ROWS:
                    past_row = df_window.iloc[entry_idx - FALLING_KNIFE_ROWS]
                    delta = signal_price - past_row[ask_col]
                    passed = not ((direction == "UP" and delta > FALLING_KNIFE_DELTA) or 
                                  (direction == "DOWN" and delta < -FALLING_KNIFE_DELTA))
                if passed:
                    spread = signal_price - signal_row[bid_col]
                    if spread > MAX_SPREAD: passed = False
                if passed and entry_price > threshold + 0.02:
                    passed = False
                    
                if not passed: continue
                
                # Only use Mid buckets
                ttr = MARKET_WINDOW_SECONDS - signal_row["elapsed"]
                if classify_ttr(ttr) != "Mid": continue
                
                df_future = df_window.iloc[entry_idx+1:]
                pl_mask = df_future[ask_col] >= PROFIT_LOCK_PRICE
                pl_idx = pl_mask.idxmax() if pl_mask.any() else None
                
                for sl_val in PHASE1_SL_VALS:
                    if sl_val >= threshold: continue
                    if signal_row[bid_col] <= sl_val: continue
                    
                    sl_mask = df_future[ask_col] <= sl_val
                    sl_idx = sl_mask.idxmax() if sl_mask.any() else None
                    
                    exit_type, exit_pnl, sub_type = determine_exit(pl_idx, sl_idx, entry_price, sl_val, is_winner)
                    p1_trades.append({
                        "Threshold": threshold,
                        "SL": sl_val,
                        "Direction": direction,
                        "n": 1,
                        "entry_price": entry_price,
                        "exit_type": exit_type,
                        "sub_type": sub_type,
                        "pnl": exit_pnl
                    })

            # --- PHASE 2 ---
            for trigger in PHASE2_TRIGGERS:
                for delta in PHASE2_DELTAS:
                    entry_max = trigger + delta
                    entry_mask = (df_window[ask_col] >= trigger) & (df_window[ask_col] <= entry_max)
                    if not entry_mask.any(): continue
                    entry_idx = entry_mask.idxmax()
                    
                    signal_row = df_window.iloc[entry_idx]
                    signal_price = signal_row[ask_col]
                    entry_price = signal_price * (1 + BUY_PRICE_BUFFER)
                    
                    # F1, F2, F3
                    passed = True
                    if entry_idx >= FALLING_KNIFE_ROWS:
                        past_row = df_window.iloc[entry_idx - FALLING_KNIFE_ROWS]
                        d = signal_price - past_row[ask_col]
                        passed = not ((direction == "UP" and d > FALLING_KNIFE_DELTA) or 
                                      (direction == "DOWN" and d < -FALLING_KNIFE_DELTA))
                    if passed:
                        spread = signal_price - signal_row[bid_col]
                        if spread > MAX_SPREAD: passed = False
                    if passed and entry_price > entry_max + 0.02:
                        passed = False
                        
                    if not passed: continue
                    
                    ttr = MARKET_WINDOW_SECONDS - signal_row["elapsed"]
                    if classify_ttr(ttr) != "Mid": continue
                    
                    df_future = df_window.iloc[entry_idx+1:]
                    pl_mask = df_future[ask_col] >= PROFIT_LOCK_PRICE
                    pl_idx = pl_mask.idxmax() if pl_mask.any() else None
                    
                    for sl_val in PHASE2_SL_VALS:
                        if sl_val >= entry_max: continue
                        if signal_row[bid_col] <= sl_val: continue
                        
                        sl_mask = df_future[ask_col] <= sl_val
                        sl_idx = sl_mask.idxmax() if sl_mask.any() else None
                        
                        exit_type, exit_pnl, sub_type = determine_exit(pl_idx, sl_idx, entry_price, sl_val, is_winner)
                        p2_trades.append({
                            "Trigger": trigger,
                            "Max Buy": entry_max,
                            "Band Width": delta,
                            "SL": sl_val,
                            "Direction": direction,
                            "n": 1,
                            "entry_price": entry_price,
                            "exit_type": exit_type,
                            "sub_type": sub_type,
                            "pnl": exit_pnl
                        })
                        
    sys.stdout.write("\r  Processing complete!                         \n")
    return pd.DataFrame(p1_trades), pd.DataFrame(p2_trades)

def print_markdown_table(df: pd.DataFrame, title: str):
    print(f"\n{'='*100}")
    print(f"  {title}")
    print(f"{'='*100}\n")
    
    if df.empty:
        print("  (no data)\n")
        return
        
    cols = df.columns.tolist()
    header = "| " + " | ".join(str(c) for c in cols) + " |"
    sep = "| " + " | ".join("---" for _ in cols) + " |"
    
    print(header)
    print(sep)
    for _, row in df.iterrows():
        vals = []
        for c in cols:
            v = row[c]
            if isinstance(v, float):
                if c in ["Exp PnL/Trade", "Δ vs SL=0.50", "Δ vs Point Entry"]:
                    vals.append(f"${v:.4f}")
                elif "%" in c or c == "Res%":
                    vals.append(f"{v:.2f}%")
                else:
                    vals.append(f"{v:.4f}")
            else:
                vals.append(str(v))
        print("| " + " | ".join(vals) + " |")
    print()

def main():
    print("═" * 80)
    print("  PHASE 2 REFINEMENT — SL Sensitivity & Entry Band Sweeps")
    print("═" * 80)
    
    print("\nLoading dataset...")
    df = pd.read_csv(DATASET_PATH)
    df = df.sort_values(["slug", "elapsed"]).reset_index(drop=True)
    
    print("\nRunning simulations...")
    df_p1, df_p2 = simulate_markets(df)
    
    # ---------------------------------------------------------
    # TABEL A — FINE-GRAINED SL SENSITIVITY
    # ---------------------------------------------------------
    tabel_a_rows = []
    if not df_p1.empty:
        for (thresh, sl, dir_), grp in df_p1.groupby(["Threshold", "SL", "Direction"]):
            n = len(grp)
            if n == 0: continue
            
            exp_pnl = grp["pnl"].mean()
            pl_pct = (grp["exit_type"] == "PL").mean() * 100
            sl_pct = (grp["exit_type"] == "SL").mean() * 100
            
            sl_false_stops = len(grp[grp["sub_type"] == "SL_FALSE_STOP"])
            sl_total = len(grp[grp["exit_type"] == "SL"])
            sl_false_pct = (sl_false_stops / sl_total * 100) if sl_total > 0 else 0.0
            
            res_pct = (grp["exit_type"].isin(["RES_WIN", "RES_LOSS"])).mean() * 100
            
            tabel_a_rows.append({
                "Threshold": thresh,
                "SL": sl,
                "Direction": dir_,
                "n": n,
                "Exp PnL/Trade": exp_pnl,
                "PL%": pl_pct,
                "SL%": sl_pct,
                "SL_FALSE%": sl_false_pct,
                "Res%": res_pct
            })
            
    df_ta = pd.DataFrame(tabel_a_rows)
    if not df_ta.empty:
        # Add Delta vs SL=0.50
        df_ta["Δ vs SL=0.50"] = np.nan
        for (thresh, dir_), grp in df_ta.groupby(["Threshold", "Direction"]):
            baseline = grp[grp["SL"] == 0.50]
            if not baseline.empty:
                base_pnl = baseline.iloc[0]["Exp PnL/Trade"]
                mask = (df_ta["Threshold"] == thresh) & (df_ta["Direction"] == dir_)
                df_ta.loc[mask, "Δ vs SL=0.50"] = df_ta.loc[mask, "Exp PnL/Trade"] - base_pnl
                
        # Reorder columns & sort
        cols = ["Threshold", "SL", "Direction", "n", "Exp PnL/Trade", "Δ vs SL=0.50", "PL%", "SL%", "SL_FALSE%", "Res%"]
        df_ta = df_ta[cols].sort_values("Exp PnL/Trade", ascending=False)
        
    print_markdown_table(df_ta, "TABEL A — FINE-GRAINED SL SENSITIVITY")

    # ---------------------------------------------------------
    # TABEL B — ENTRY BAND ANALYSIS
    # ---------------------------------------------------------
    tabel_b_rows = []
    if not df_p2.empty:
        for (trig, max_buy, width, sl, dir_), grp in df_p2.groupby(["Trigger", "Max Buy", "Band Width", "SL", "Direction"]):
            n = len(grp)
            if n == 0: continue
            
            avg_entry = grp["entry_price"].mean()
            exp_pnl = grp["pnl"].mean()
            
            tabel_b_rows.append({
                "Trigger": trig,
                "Max Buy": max_buy,
                "Band Width": width,
                "SL": sl,
                "Direction": dir_,
                "n": n,
                "Avg Entry Price": avg_entry,
                "Exp PnL/Trade": exp_pnl
            })
            
    df_tb = pd.DataFrame(tabel_b_rows)
    if not df_tb.empty:
        df_tb["Δ vs Point Entry"] = np.nan
        if not df_ta.empty:
            for idx, row in df_tb.iterrows():
                base_mask = (df_ta["Threshold"] == row["Trigger"]) & (df_ta["SL"] == row["SL"]) & (df_ta["Direction"] == row["Direction"])
                baseline = df_ta[base_mask]
                if not baseline.empty:
                    base_pnl = baseline.iloc[0]["Exp PnL/Trade"]
                    df_tb.at[idx, "Δ vs Point Entry"] = row["Exp PnL/Trade"] - base_pnl
        
        cols = ["Trigger", "Max Buy", "Band Width", "SL", "Direction", "n", "Avg Entry Price", "Exp PnL/Trade", "Δ vs Point Entry"]
        df_tb = df_tb[cols].sort_values("Exp PnL/Trade", ascending=False)
        
    print_markdown_table(df_tb, "TABEL B — ENTRY BAND ANALYSIS")

    # ---------------------------------------------------------
    # TABEL C — FINAL CONFIG RECOMMENDATION
    # ---------------------------------------------------------
    # Gather candidates from Phase 1 and Phase 2
    candidates = []
    if not df_ta.empty:
        for _, row in df_ta.iterrows():
            candidates.append({
                "Direction": row["Direction"],
                "BUY_TRIGGER": row["Threshold"],
                "MAX_BUY": row["Threshold"] + 0.02,
                "SL": row["SL"],
                "Expected PnL/Trade": row["Exp PnL/Trade"],
                "n": row["n"],
                "Confidence": "HIGH" if row["n"] >= 100 else "MED"
            })
            
    if not df_tb.empty:
        for _, row in df_tb.iterrows():
            candidates.append({
                "Direction": row["Direction"],
                "BUY_TRIGGER": row["Trigger"],
                "MAX_BUY": row["Max Buy"],
                "SL": row["SL"],
                "Expected PnL/Trade": row["Exp PnL/Trade"],
                "n": row["n"],
                "Confidence": "HIGH" if row["n"] >= 100 else "MED"
            })
            
    df_candidates = pd.DataFrame(candidates)
    
    print(f"\n{'='*100}")
    print("  TABEL C — FINAL CONFIG RECOMMENDATION")
    print(f"{'='*100}\n")
    
    if not df_candidates.empty:
        df_optimal = []
        for d in DIRECTIONS:
            d_cand = df_candidates[df_candidates["Direction"] == d]
            if not d_cand.empty:
                best = d_cand.loc[d_cand["Expected PnL/Trade"].idxmax()]
                df_optimal.append(best)
                
        df_best = pd.DataFrame(df_optimal)
        header = "| Direction | BUY_TRIGGER | MAX_BUY | SL | Expected PnL/Trade | n | Confidence |"
        sep = "| --- | --- | --- | --- | --- | --- | --- |"
        print(header)
        print(sep)
        
        for _, row in df_best.iterrows():
            d = row["Direction"]
            bt = f"{row['BUY_TRIGGER']:.2f}"
            mb = f"{row['MAX_BUY']:.2f}"
            sl = f"{row['SL']:.2f}"
            pnl = f"${row['Expected PnL/Trade']:.4f}"
            n = str(int(row['n']))
            conf = row["Confidence"]
            print(f"| {d} | {bt} | {mb} | {sl} | {pnl} | {n} | {conf} |")
        
        print("\n  Blok Rekomendasi .env Siap-Salin (Optimal Overall):")
        # Find absolute best among all directions for the final env block
        best_overall = df_best.loc[df_best["Expected PnL/Trade"].idxmax()]
        print("  ┌─────────────────────────────────────────┐")
        print(f"  │  BUY_TRIGGER_PRICE={best_overall['BUY_TRIGGER']:.2f}                 │")
        print(f"  │  MAX_BUY_PRICE={best_overall['MAX_BUY']:.2f}                     │")
        print("  │  PROFIT_LOCK_PRICE=0.99                 │")
        print(f"  │  STOP_LOSS_PRICE={best_overall['SL']:.2f}                   │")
        print("  └─────────────────────────────────────────┘")
    else:
        print("  (no sufficient data to form recommendations)")
    
    print()

if __name__ == "__main__":
    main()
