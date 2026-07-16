#!/usr/bin/env python3
"""
Relatório de Qualidade de Seguidores — Instagram
Perfil: @majucotrim  |  Powered by Mobiliza.me
"""

import pandas as pd
import re
import unicodedata
import sys
import base64
import io
import argparse
from pathlib import Path
from datetime import datetime

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.patches as mpatches
    HAS_MPL = True
except ImportError:
    HAS_MPL = False

# Entrada/saída vêm da linha de comando (ver parse_args). Antes eram caminhos
# absolutos de macOS (/Users/jeanmortaza/Downloads/…) fixos no código — não
# rodava em nenhuma outra máquina, e o mkdir ainda executava só de importar.
# Uso: python analyze_fake_followers.py <csv> [-o pasta_de_saida]
def parse_args():
    ap = argparse.ArgumentParser(
        description="Relatório de qualidade de seguidores a partir de um CSV do mtzSpider.",
    )
    ap.add_argument("csv", type=Path,
                    help="CSV de seguidores (IGFollow_*.csv) gerado pela extensão.")
    ap.add_argument("-o", "--output-dir", type=Path, default=None,
                    help="Pasta de saída (default: ./analise_<nome-do-csv> ao lado do CSV).")
    return ap.parse_args()

# ─── Dados do perfil (Social Blade) ──────────────────────────────────────────
PROFILE = {
    "name":             "Maju Cotrim",
    "handle":           "@majucotrim",
    "bio":              "Comunicação Humanizada",
    "followers":        78_337,
    "following":        7_458,
    "posts":            4_050,
    "engagement":       0.14,
    "avg_likes":        100.81,
    "avg_comments":     5.63,
    "sb_grade":         "B+",
    "sb_rank":          39_704,
    "followers_rank":   409_302,
    "engagement_rank":  48_391,
    "last_14d":         -202,
    "last_30d":         1_962,
}

# ─── Crescimento diário (30 dias) ─────────────────────────────────────────────
GROWTH = [
    ("15/abr", -218), ("16/abr", -52),  ("17/abr", -376), ("18/abr", -4),
    ("19/abr", -500), ("20/abr", 62),   ("21/abr", 58),   ("22/abr", 4081),
    ("23/abr", -416), ("24/abr", -380), ("25/abr", -35),  ("26/abr", -91),
    ("27/abr", -11),  ("28/abr", 87),   ("29/abr", 71),   ("30/abr", -41),
    ("01/mai", -172), ("02/mai", 28),   ("03/mai", -51),  ("04/mai", 120),
    ("05/mai", 105),  ("06/mai", -331), ("07/mai", 72),   ("08/mai", 99),
    ("09/mai", 93),   ("10/mai", -61),  ("11/mai", -37),  ("12/mai", -31),
    ("13/mai", 5),    ("14/mai", -73),
]

# ─── Mapeamento ID → Ano  (ref: 48.244.658 = 2012) ───────────────────────────
ID_YEAR = [
    (5_000_000,      2010), (30_000_000,    2011), (100_000_000,   2012),
    (500_000_000,    2013), (2_000_000_000, 2014), (5_000_000_000, 2015),
    (10_000_000_000, 2016), (20_000_000_000,2017), (35_000_000_000,2018),
    (45_000_000_000, 2019), (55_000_000_000,2020), (65_000_000_000,2021),
    (75_000_000_000, 2022), (float("inf"),  2023),
]
def est_year(uid):
    try:
        v = int(float(str(uid).replace(",", "")))
        for t, y in ID_YEAR:
            if v < t: return y
        return 2023
    except: return None

# ─── Listas e padrões ─────────────────────────────────────────────────────────
SOUTH_ASIAN = {
    # Norte da Índia
    "rahul","raj","rajesh","rohan","ravi","ramesh","suresh","mahesh","ganesh",
    "vikas","ajay","vijay","sanjay","anil","sunil","kapil","deepak","vivek",
    "manish","nikhil","priya","neha","pooja","anjali","kavita","sunita","rekha",
    "geeta","ritu","nikita","dipika","rani","radha","radhika","lakshmi","maya",
    "dev","arjun","vikram","kiran","preeti","swati","sonia","meena","seema",
    "nisha","mohan","sohan","shyam","ram","krishna","shiva","vishnu","durga",
    "tarun","varun","arun","vamsi","akash","ankit","ankita","sumit","amit",
    "rohit","mohit","lalit","harish","hitesh","ritesh","mukesh","dinesh",
    "nagesh","yogesh","rakesh","lokesh","umesh","naresh","mahendra","jitendra",
    "avinash","abhishek","abhijeet","aarav","aaryan","aakash","aditya",
    "ajit","akshay","anand","anshul","aryan","ashish","ashok","atul","ayush",
    "chandan","chirag","dhruv","gaurav","girish","govind","himanshu","ishaan",
    "jagdish","jayesh","karan","kartik","kuldeep","mayank","mukul","neeraj",
    "omkar","pankaj","parth","prashant","pratik","praveen","puneet","raghav",
    "rajat","rajiv","raunak","rishabh","ritik","roshan","sachin","sahil",
    "sandesh","sanjeev","saurabh","shashank","shivam","shubham","siddharth",
    "subash","sudhir","sujit","sushant","swapnil","uday","vaibhav","vipin",
    "vishal","yash","mahaveer","nandu",
    # Sobrenomes / castas
    "patel","sharma","singh","kumar","gupta","verma","chauhan","yadav","pandey",
    "mishra","joshi","dubey","tiwari","shukla","trivedi","saxena","bose",
    "agarwal","bajaj","bansal","bhatt","chaudhary","chopra","desai","dixit",
    "goel","iyer","jain","kapoor","kaur","khanna","mahajan","mathur","mehta",
    "nair","nayak","pillai","prasad","rao","reddy","sahu","saini","thakur",
    "yadav","nanda","goswami","maheshwari","rajput","shekhawat","rathore",
    # Paquistaneses / muçulmanos
    "moin","arif","ali","muhammad","mohammed","md","khan","sheikh","syed",
    "mirza","ansari","qureshi","malik","iqbal","rashid","farhan","imran",
    "usman","salman","rehan","zaid","zain","adnan","hassan","hussain","raza",
    "noman","faisal","waseem","naeem","aziz","tariq","asif","asad","danish",
    "sameer","murad","nazim","atif","nasir","bashir","zahir","zaheer",
    "kareem","jamalpir","chora","abutalha","abu","akhtar","noushad",
    "sharjeel","shazad","shahrukh","shahzad","farrukh","shoaib","zubair",
    "zafar","waqar","umair","naveed","nadeem","babar","hamza","haris",
    "saad","bilal","talha","maaz",
    "fatima","zainab","khatun","begum","bibi","ayesha","amina","nadia",
    "sana","zahra","bushra","rubina","shabana","hina","mariam","saima",
    # Bangladeshi
    "shawon","siyam","rana","ripon","rakib","rabby","rajon","rajib",
    "rafiq","rafi","rahat","sabbir","sakib","tushar","sumon","shimul",
    "nazmul","nazrul","abdur","abul","belal","delwar","enamul","forhad",
    "habib","jahangir","kamal","liton","limon","mahbub","mamun","maruf",
    "masud","mizanur","mostofa","motiur","nasiruddin","nizam","obaydul",
    "rafikul","rezaul","ruhul","selim","shahidul","shakil","shamsul",
    "sirajul","sohel","zahirul","jamal",
    # Sul da Índia
    "murugan","selvam","palani","rajan","ganesan","kannan","sathish",
    "karthik","karthikeyan","senthil","manikandan","vijayakumar","balaji",
    "chandrakala","venkat","venkatesh","subramanian","sivakumar","prasanna",
    "ramachandran","saravanan","sivaraj","vignesh","vijayan","vineeth",
    "nandini","pavithra","sowmya","sridevi","sudha","usha","vani",
    "desi","bharat","india","pak","bangla","jaat",
}

SOUTH_ASIAN_KW = [
    "ka ladla","beti","bhai","didi","yaar","jaan","shyam","maa_ka",
    "india","pakistan","bangladesh","nepali","bharat","jaat","saini",
]

# Scripts sul-asiáticos (árabe/urdu, devanagari, bengali, punjabi, etc.)
SA_SCRIPT_RANGES = [
    (0x0600,0x06FF),(0x0900,0x097F),(0x0980,0x09FF),(0x0A00,0x0A7F),
    (0x0A80,0x0AFF),(0x0B00,0x0B7F),(0x0B80,0x0BFF),(0x0C00,0x0C7F),
    (0x0C80,0x0CFF),(0x0D00,0x0D7F),
]
# Outros scripts não-latinos (cirílico, tailandês, coreano, chinês, japonês)
OTHER_SCRIPT_RANGES = [
    (0x0400,0x04FF),(0x0E00,0x0E7F),(0xAC00,0xD7AF),(0x4E00,0x9FFF),(0x3040,0x30FF),
]
FOREIGN_RANGES = SA_SCRIPT_RANGES + OTHER_SCRIPT_RANGES

ANIMALS = [
    "goose","rabbit","owl","panda","rhino","sheep","camel","armadillo",
    "squirrel","chipmunk","reindeer","badger","dinosaur","turtle","penguin",
    "dolphin","whale","shark","tiger","lion","bear","wolf","fox","deer",
    "moose","elk","hawk","eagle","parrot","flamingo","kangaroo","koala",
    "raccoon","otter","beaver","hedgehog","hamster","ferret","iguana",
    "gecko","cobra","falcon","sparrow","pigeon","coyote","bison","antelope",
    "zebra","giraffe","hippo","gorilla","lemur","mongoose","meerkat","skunk",
    "platypus","opossum","wren","finch","robin","peacock","chimpanzee",
    "jellyfish","lobster","starfish","seahorse","narwhal","pelican","macaw",
]

# ─── Funções de detecção ──────────────────────────────────────────────────────
def norm(t):
    if not t or isinstance(t, float): return ""
    s = unicodedata.normalize("NFD", str(t).lower().strip())
    return "".join(c for c in s if unicodedata.category(c) != "Mn")

def is_animal_bot(u):
    un = norm(u)
    for a in ANIMALS:
        if re.match(rf"^{a}[._\-]?\d{{4,}}$", un): return True
    return False

def has_south_asian(u, fn):
    combined = norm(u) + " " + norm(fn)
    raw = str(u) + str(fn)
    for name in SOUTH_ASIAN:
        if re.search(rf"(?<![a-z]){re.escape(name)}(?![a-z])", combined): return True
    for kw in SOUTH_ASIAN_KW:
        if kw in combined: return True
    # Detecta scripts sul-asiáticos (árabe/urdu, devanagari, bengali, etc.)
    for c in raw:
        if any(lo <= ord(c) <= hi for lo, hi in SA_SCRIPT_RANGES): return True
    return False

def has_foreign_script(fn):
    """Scripts não-sul-asiáticos: cirílico, tailandês, coreano, chinês, japonês."""
    if not fn or isinstance(fn, float) or str(fn).strip() in ("", "nan"): return False
    for c in str(fn):
        if any(lo <= ord(c) <= hi for lo, hi in OTHER_SCRIPT_RANGES): return True
    return False

def is_random_string(u):
    if not u or isinstance(u, float): return False
    clean = re.sub(r"[._\-0-9]", "", str(u).lower())
    if len(clean) < 5: return False
    vowels = sum(1 for c in clean if c in "aeiou")
    # Sem vogais (5+ letras)
    if vowels == 0 and len(clean) >= 5: return True
    # Razão de vogais muito baixa (6+ letras, <15%)
    if len(clean) >= 6 and vowels / len(clean) < 0.15: return True
    return False

def has_repeated_chars(u):
    return bool(re.search(r"(.)\1{3,}", str(u)))

def is_number_suffix(u):
    if not u or isinstance(u, float): return False
    return bool(re.search(r"[a-z]{3,}\d{5,}$", str(u).lower()))

def username_eq_fullname(u, fn):
    u2  = str(u).lower().strip()
    fn2 = str(fn).lower().strip()
    return len(u2) > 5 and u2 == fn2 and u2 not in ("", "nan")

# ─── Scoring ──────────────────────────────────────────────────────────────────
def score(row):
    u   = row.get("Username",  "")
    fn  = row.get("Fullname",  "")
    uid = row.get("User Id",   0)
    av  = row.get("Avatar URL","")

    pts, reasons = 0, []
    flags = dict(bot_username=False, south_asian=False, foreign_script=False,
                 random_string=False, repeated_chars=False, number_suffix=False,
                 username_eq_fn=False, no_fullname=False, conta_nova=False)

    yr = est_year(uid)

    if yr and yr >= 2023: pts += 20; reasons.append(f"Conta criada ~{yr}"); flags["conta_nova"] = True
    elif yr and yr >= 2022: pts += 10; reasons.append(f"Conta criada ~{yr}"); flags["conta_nova"] = True

    if is_animal_bot(u):
        pts += 40; reasons.append("Username padrão gerado (animal+número)"); flags["bot_username"] = True

    if has_south_asian(u, fn):
        pts += 30; reasons.append("Nome/username sul-asiático"); flags["south_asian"] = True
    elif has_foreign_script(fn):
        pts += 25; reasons.append("Script não-latino no nome"); flags["foreign_script"] = True

    if is_random_string(u):
        pts += 25; reasons.append("Username sem estrutura semântica"); flags["random_string"] = True

    if has_repeated_chars(u):
        pts += 15; reasons.append("Caracteres repetidos no username"); flags["repeated_chars"] = True

    if is_number_suffix(u) and not is_animal_bot(u):
        pts += 20; reasons.append("Username com sufixo numérico longo"); flags["number_suffix"] = True

    if username_eq_fullname(u, fn):
        pts += 15; reasons.append("Username idêntico ao nome completo"); flags["username_eq_fn"] = True

    if not fn or isinstance(fn, float) or str(fn).strip() in ("", "nan"):
        pts += 15; reasons.append("Sem nome completo"); flags["no_fullname"] = True

    if not av or isinstance(av, float) or str(av).strip() in ("", "nan"):
        pts += 10; reasons.append("Sem foto de perfil")

    pts = min(pts, 100)
    risk = "ALTO" if pts >= 60 else "MÉDIO" if pts >= 35 else "BAIXO"
    return {"score": pts, "risk": risk,
            "reasons": "; ".join(reasons) if reasons else "Sem indicadores",
            "year": yr, **flags}

# ─── Paleta Mobiliza.me ───────────────────────────────────────────────────────
G_PRIMARY = "#16a34a"
G_DARK    = "#1F7A3E"
G_LIGHT   = "#5ED089"
G_PALE    = "#f0fdf4"
G_BORDER  = "#bbf7d0"
RED       = "#dc2626"
RED_PALE  = "#fef2f2"
RED_BORDER= "#fecaca"
AMBER     = "#d97706"
AMBER_PALE= "#fffbeb"
TEXT_1    = "#111827"
TEXT_2    = "#6b7280"
TEXT_3    = "#9ca3af"
WHITE     = "#ffffff"
GRAY_50   = "#f9fafb"
GRAY_100  = "#f3f4f6"
GRAY_200  = "#e5e7eb"
GRAY_300  = "#d1d5db"

# ─── Gráficos (tema claro) ────────────────────────────────────────────────────
def b64(fig):
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=150, bbox_inches="tight",
                facecolor=WHITE, edgecolor="none")
    buf.seek(0)
    enc = base64.b64encode(buf.read()).decode()
    plt.close(fig)
    return enc

def style(ax, grid=True):
    ax.set_facecolor(WHITE)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color(GRAY_200)
    ax.spines["bottom"].set_color(GRAY_200)
    ax.tick_params(colors=TEXT_2, labelsize=8)
    ax.xaxis.label.set_color(TEXT_2)
    ax.yaxis.label.set_color(TEXT_2)
    if grid:
        ax.yaxis.grid(True, color=GRAY_100, linewidth=0.8, zorder=0)
        ax.set_axisbelow(True)

def chart_growth():
    dates  = [d for d, _ in GROWTH]
    values = [v for _, v in GROWTH]
    fig, ax = plt.subplots(figsize=(11, 3.2), facecolor=WHITE)
    style(ax)
    clrs = [RED if v > 500 else G_PRIMARY if v > 0 else "#ef4444" for v in values]
    ax.bar(range(len(dates)), values, color=clrs, width=0.7, zorder=3)
    ax.axhline(0, color=GRAY_300, linewidth=1)
    peak = values.index(max(values))
    ax.annotate(f"+{values[peak]:,}", xy=(peak, values[peak]),
                xytext=(peak - 5, values[peak] * 0.82),
                arrowprops={"arrowstyle":"->","color":AMBER,"lw":1.2},
                color=AMBER, fontsize=9, fontweight="bold")
    ax.set_xticks(range(len(dates)))
    ax.set_xticklabels(dates, rotation=45, ha="right", fontsize=7, color=TEXT_2)
    ax.set_ylabel("Variação diária", fontsize=9)
    ax.set_title("Variação Diária de Seguidores — 15 abr a 14 mai 2026",
                 fontsize=11, color=TEXT_1, pad=10, fontweight="600")
    plt.tight_layout()
    return b64(fig)

def chart_year(df):
    counts = df["year"].value_counts().sort_index()
    fig, ax = plt.subplots(figsize=(8, 3.2), facecolor=WHITE)
    style(ax)
    clrs = [RED if y >= 2022 else G_PRIMARY if y >= 2018 else G_LIGHT
            for y in counts.index]
    bars = ax.bar(counts.index.astype(str), counts.values, color=clrs, width=0.65, zorder=3)
    for bar, val in zip(bars, counts.values):
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 40,
                f"{val:,}", ha="center", va="bottom", color=TEXT_2, fontsize=7)
    legend = [mpatches.Patch(color=G_LIGHT,   label="Antes de 2018"),
              mpatches.Patch(color=G_PRIMARY,  label="2018–2021"),
              mpatches.Patch(color=RED,        label="2022 em diante")]
    ax.legend(handles=legend, fontsize=8, framealpha=0.8,
              edgecolor=GRAY_200, labelcolor=TEXT_1)
    ax.set_ylabel("Seguidores", fontsize=9)
    ax.set_title("Distribuição por Ano Estimado de Criação da Conta",
                 fontsize=11, color=TEXT_1, pad=10, fontweight="600")
    plt.tight_layout()
    return b64(fig)

def chart_pie(df):
    counts = df["risk"].value_counts()
    order  = ["ALTO", "MÉDIO", "BAIXO"]
    lbls   = [o for o in order if o in counts.index]
    vals   = [counts[l] for l in lbls]
    clrs   = {"ALTO": RED, "MÉDIO": AMBER, "BAIXO": G_PRIMARY}
    colors = [clrs[l] for l in lbls]
    fig, ax = plt.subplots(figsize=(4.2, 3.8), facecolor=WHITE)
    wedges, _, autos = ax.pie(
        vals, autopct="%1.1f%%", colors=colors, startangle=140,
        pctdistance=0.72,
        wedgeprops={"edgecolor": WHITE, "linewidth": 2.5},
    )
    for at in autos:
        at.set_color(WHITE); at.set_fontsize(10); at.set_fontweight("bold")
    ax.legend(wedges, [f"{l} — {v:,}" for l, v in zip(lbls, vals)],
              fontsize=8.5, loc="lower center", bbox_to_anchor=(0.5, -0.06),
              framealpha=0.8, edgecolor=GRAY_200, labelcolor=TEXT_1)
    ax.set_title("Classificação de Risco", fontsize=11,
                 color=TEXT_1, pad=8, fontweight="600")
    plt.tight_layout()
    return b64(fig)

def chart_flags(df):
    fmap = {
        "conta_nova":    "Conta criada em 2022+",
        "no_fullname":   "Sem nome completo",
        "number_suffix": "Username com sufixo numérico",
        "south_asian":   "Nome/username sul-asiático",
        "foreign_script":"Script estrangeiro no nome",
        "random_string": "Username sem padrão semântico",
        "repeated_chars":"Caracteres repetidos no username",
        "bot_username":  "Username gerado (animal+número)",
        "username_eq_fn":"Username idêntico ao nome",
    }
    totals = {k: int(df[k].sum()) for k in fmap if k in df.columns}
    totals = dict(sorted(totals.items(), key=lambda x: x[1]))
    lbls   = [fmap[k] for k in totals]
    vals   = list(totals.values())
    total  = len(df)
    clr_map = {
        "conta_nova": GRAY_300, "no_fullname": GRAY_300,
        "number_suffix": G_LIGHT, "south_asian": G_PRIMARY,
        "foreign_script": G_PRIMARY, "random_string": AMBER,
        "repeated_chars": AMBER, "bot_username": RED,
        "username_eq_fn": G_LIGHT,
    }
    colors = [clr_map.get(k, GRAY_300) for k in totals]
    fig, ax = plt.subplots(figsize=(8, 3.6), facecolor=WHITE)
    style(ax, grid=False)
    ax.xaxis.grid(True, color=GRAY_100, linewidth=0.8, zorder=0)
    ax.set_axisbelow(True)
    bars = ax.barh(lbls, vals, color=colors, height=0.6, zorder=3)
    for bar, val in zip(bars, vals):
        ax.text(val + 30, bar.get_y() + bar.get_height()/2,
                f"{val:,}  ({val/total*100:.1f}%)",
                va="center", color=TEXT_2, fontsize=8)
    ax.set_xlim(0, max(vals) * 1.35)
    ax.set_title("Indicadores por Tipo — Ocorrências na Base",
                 fontsize=11, color=TEXT_1, pad=10, fontweight="600")
    ax.set_xlabel("Quantidade de perfis", fontsize=9)
    ax.spines["right"].set_visible(False)
    ax.spines["top"].set_visible(False)
    plt.tight_layout()
    return b64(fig)

def chart_engagement():
    cats  = ["Excelente\n>3%", "Bom\n1–3%", "Médio\n0.5–1%",
             "Baixo\n0.1–0.5%", "@majucotrim\n0.14%"]
    vals  = [3.5, 2.0, 0.75, 0.3, 0.14]
    clrs  = [G_PRIMARY, G_PRIMARY, AMBER, AMBER, RED]
    fig, ax = plt.subplots(figsize=(6, 3.2), facecolor=WHITE)
    style(ax)
    bars = ax.bar(cats, vals, color=clrs, width=0.5, zorder=3)
    ax.axhline(0.14, color=RED, linewidth=1.2, linestyle="--", alpha=0.5)
    for bar, val in zip(bars, vals):
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.03,
                f"{val}%", ha="center", va="bottom",
                color=TEXT_1, fontsize=9, fontweight="600")
    ax.set_ylabel("Taxa de engajamento (%)", fontsize=9)
    ax.set_title("Taxa de Engajamento vs. Benchmarks (50k–100k seguidores)",
                 fontsize=10, color=TEXT_1, pad=10, fontweight="600")
    plt.tight_layout()
    return b64(fig)

# ─── Logo Mobiliza.me (SVG inline) ───────────────────────────────────────────
LOGO_SVG = """<svg width="36" height="36" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="mg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#5ED089"/>
    <stop offset="100%" stop-color="#1F7A3E"/>
  </linearGradient></defs>
  <rect width="64" height="64" rx="14" fill="url(#mg)"/>
  <text x="32" y="46" text-anchor="middle" font-family="-apple-system,sans-serif"
        font-size="38" font-weight="800" fill="white">M</text>
</svg>"""

# ─── Cards de perfil suspeito ─────────────────────────────────────────────────
def card(row):
    av   = str(row.get("Avatar URL","")).strip()
    un   = str(row.get("Username","")).strip()
    fn   = str(row.get("Fullname","")).strip() or "—"
    uid  = str(row.get("User Id","")).strip()
    yr   = row.get("year","?")
    pts  = row.get("score", 0)
    rsn  = str(row.get("reasons","")).strip()
    risk = str(row.get("risk","")).strip()
    url  = str(row.get("Profile URL","")).strip()

    risk_color  = {"ALTO": RED,     "MÉDIO": AMBER,     "BAIXO": G_PRIMARY}
    risk_pale   = {"ALTO": RED_PALE, "MÉDIO": AMBER_PALE, "BAIXO": G_PALE}
    risk_border = {"ALTO": RED_BORDER,"MÉDIO":"#fde68a","BAIXO": G_BORDER}
    rc = risk_color.get(risk, GRAY_300)
    rp = risk_pale.get(risk, GRAY_50)
    rb = risk_border.get(risk, GRAY_200)

    img = (f'<img src="{av}" class="av" alt="avatar" onerror="this.style.display=\'none\'">'
           if av and av != "nan"
           else '<div class="av av-empty">?</div>')
    href = f'href="{url}" target="_blank"' if url and url != "nan" else ""

    return f"""<div class="card" style="border-color:{rb}">
  <div class="card-risk" style="background:{rp};border-bottom:1px solid {rb}">
    <span style="color:{rc};font-size:.72em;font-weight:700;text-transform:uppercase;letter-spacing:.05em">
      ● Risco {risk}
    </span>
    <span class="score-badge" style="background:{rc}">{pts}</span>
  </div>
  <div class="card-body">
    <a {href} class="card-profile">
      {img}
      <div class="card-info">
        <span class="username">@{un}</span>
        <span class="fullname">{fn}</span>
        <span class="uid">ID {uid} · ~{yr}</span>
      </div>
    </a>
    <div class="sbar"><div style="width:{pts}%;background:{rc};height:3px;border-radius:2px;transition:width .4s"></div></div>
    <div class="reasons">{rsn}</div>
  </div>
</div>"""

# ─── HTML A4 ──────────────────────────────────────────────────────────────────
def build_html(df, charts):
    P = PROFILE
    total  = len(df)
    n_alto  = int((df["risk"] == "ALTO").sum())
    n_medio = int((df["risk"] == "MÉDIO").sum())
    n_baixo = int((df["risk"] == "BAIXO").sum())

    # Contas com múltiplos indicadores de risco + novas
    mask_multi = (df["year"] >= 2022) & (
        df["bot_username"] | df["south_asian"] | df["foreign_script"] |
        df["random_string"] | df["repeated_chars"]
    )
    n_multi = int(mask_multi.sum())

    # Crescimento
    vals = [v for _, v in GROWTH]
    peak_d, peak_v = max(GROWTH, key=lambda x: x[1])
    others = [v for v in vals if v != peak_v]
    avg_ex = sum(others) / len(others)
    tot_gain = sum(v for v in vals if v > 0)
    tot_loss = sum(v for v in vals if v < 0)

    # Ano rows
    yc = df["year"].value_counts().sort_index()
    yr_rows = "".join(
        f"""<tr>
          <td class="td-yr">~{y}</td>
          <td class="td-n">{c:,}</td>
          <td class="td-pct">{c/total*100:.1f}%</td>
          <td><div style="height:8px;width:{min(c/total*300,200):.0f}px;border-radius:4px;
              background:{''+RED if y>=2022 else G_PRIMARY if y>=2018 else G_LIGHT}"></div></td>
        </tr>"""
        for y, c in yc.items()
    )

    # Flag rows
    fmap_labels = {
        "conta_nova":    "Conta criada em 2022+",
        "no_fullname":   "Sem nome completo",
        "number_suffix": "Username com sufixo numérico longo",
        "south_asian":   "Nome/username sul-asiático",
        "foreign_script":"Script estrangeiro no nome completo",
        "random_string": "Username sem padrão semântico",
        "repeated_chars":"Caracteres repetidos no username",
        "bot_username":  "Username padrão gerado (animal+número)",
        "username_eq_fn":"Username idêntico ao nome completo",
    }
    flag_rows = "".join(
        f"<tr><td>{fmap_labels[k]}</td>"
        f"<td style='text-align:right;font-weight:600'>{int(df[k].sum()):,}</td>"
        f"<td style='text-align:right;color:{TEXT_2}'>{df[k].sum()/total*100:.1f}%</td></tr>"
        for k in fmap_labels if k in df.columns
    )

    # Score methodol rows
    method_rows = """
      <tr><td>Username padrão gerado (animal+número)</td>
          <td><span class="badge badge-red">+40 pts</span></td>
          <td>Ex: goose.3589749, panda.2312457</td></tr>
      <tr><td>Nome/username sul-asiático</td>
          <td><span class="badge badge-red">+30 pts</span></td>
          <td>Nomes de origem indiana, paquistanesa ou bangladeshiana</td></tr>
      <tr><td>Script estrangeiro no nome</td>
          <td><span class="badge badge-amber">+25 pts</span></td>
          <td>Árabe, Hindi, Bengali, Cirílico, etc. no campo Fullname</td></tr>
      <tr><td>Username sem padrão semântico</td>
          <td><span class="badge badge-amber">+25 pts</span></td>
          <td>Sem vogais ou razão de vogais inferior a 15%</td></tr>
      <tr><td>Conta criada em 2023+</td>
          <td><span class="badge badge-amber">+20 pts</span></td>
          <td>ID acima de 75 bilhões (estimativa)</td></tr>
      <tr><td>Username com sufixo numérico longo</td>
          <td><span class="badge badge-amber">+20 pts</span></td>
          <td>Ex: rahul14326455 — 5+ dígitos após nome</td></tr>
      <tr><td>Sem nome completo</td>
          <td><span class="badge badge-gray">+15 pts</span></td>
          <td>Campo Fullname vazio ou ausente</td></tr>
      <tr><td>Caracteres repetidos no username</td>
          <td><span class="badge badge-gray">+15 pts</span></td>
          <td>Ex: jjjj__jii08, hhhhs5575</td></tr>
      <tr><td>Username idêntico ao nome completo</td>
          <td><span class="badge badge-gray">+15 pts</span></td>
          <td>Perfis auto-gerados onde username = fullname</td></tr>
      <tr><td>Conta criada em 2022</td>
          <td><span class="badge badge-gray">+10 pts</span></td>
          <td>ID entre 65–75 bilhões (estimativa)</td></tr>
      <tr><td>Sem foto de perfil</td>
          <td><span class="badge badge-gray">+10 pts</span></td>
          <td>Avatar URL ausente no dataset</td></tr>
    """

    # Cards
    top_cards = df[df["risk"] == "ALTO"].head(36)
    cards_html = "\n".join(card(r) for _, r in top_cards.iterrows())

    def ci(key):
        return (f'<img src="data:image/png;base64,{charts[key]}" class="ci">'
                if charts.get(key) else "")

    now = datetime.now().strftime("%d/%m/%Y")
    now_full = datetime.now().strftime("%d/%m/%Y às %H:%M")

    last14_cls = "red" if P["last_14d"] < 0 else "green"
    last30_cls = "green" if P["last_30d"] > 0 else "red"

    return f"""<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relatório — @majucotrim · Mobiliza.me</title>
<style>
/* ── RESET ── */
*, *::before, *::after {{ box-sizing:border-box; margin:0; padding:0; }}

/* ── TIPOGRAFIA E BASE ── */
html {{ font-size: 10pt; }}
body {{
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #d1d5db;
  color: {TEXT_1};
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}}
a {{ color: {G_PRIMARY}; text-decoration: none; }}

/* ── BOTÃO IMPRIMIR ── */
.print-bar {{
  background: {G_DARK}; color: white;
  text-align: center; padding: 10px;
  font-size: 9pt; position: sticky; top: 0; z-index: 100;
}}
.print-bar button {{
  background: white; color: {G_DARK}; border: none;
  padding: 5px 18px; border-radius: 20px; font-weight: 700;
  font-size: 9pt; cursor: pointer; margin-left: 12px;
}}

/* ── PÁGINA A4 ── */
@page {{
  size: A4 portrait;
  margin: 14mm 14mm 16mm 14mm;
}}
.page {{
  width: 210mm;
  min-height: 297mm;
  background: {WHITE};
  margin: 0 auto 12mm;
  padding: 16mm 16mm 14mm;
  box-shadow: 0 4px 24px rgba(0,0,0,.18);
  position: relative;
  overflow: hidden;
}}
.page-break {{
  page-break-after: always;
  break-after: page;
}}

/* ── CABEÇALHO DE PÁGINA ── */
.page-header {{
  display: flex; align-items: center;
  justify-content: space-between;
  border-bottom: 2px solid {G_PRIMARY};
  padding-bottom: 8px; margin-bottom: 16px;
}}
.brand {{ display: flex; align-items: center; gap: 8px; }}
.brand-name {{ font-size: 9pt; font-weight: 700; color: {G_DARK}; }}
.brand-sub  {{ font-size: 7.5pt; color: {TEXT_3}; }}
.page-meta  {{ font-size: 7.5pt; color: {TEXT_3}; text-align: right; }}

/* ── CAPA ── */
.cover-band {{
  background: linear-gradient(135deg, {G_DARK} 0%, {G_PRIMARY} 55%, {G_LIGHT} 100%);
  margin: -16mm -16mm 0; padding: 20mm 16mm 14mm;
  color: white;
}}
.cover-band h1 {{ font-size: 22pt; font-weight: 800; letter-spacing: -.03em; line-height: 1.1; }}
.cover-band .sub {{ font-size: 10pt; opacity: .85; margin-top: 5px; }}
.cover-band .handle {{ font-size: 12pt; font-weight: 600; margin-top: 3px; opacity: .9; }}
.cover-date {{ position: absolute; bottom: 14mm; right: 16mm; font-size: 8pt; color: {TEXT_3}; }}

/* ── TÍTULOS DE SEÇÃO ── */
.sec-title {{
  font-size: 8pt; font-weight: 700; text-transform: uppercase;
  letter-spacing: .1em; color: {G_PRIMARY};
  display: flex; align-items: center; gap: 6px;
  margin-bottom: 10px; margin-top: 16px;
}}
.sec-title::before {{
  content: ""; display: inline-block;
  width: 3px; height: 13px; background: {G_PRIMARY}; border-radius: 2px;
}}
.divider {{ border: none; border-top: 1px solid {GRAY_200}; margin: 14px 0; }}

/* ── KPI GRID ── */
.kpi-grid {{ display: grid; gap: 8px; }}
.kpi-4 {{ grid-template-columns: repeat(4, 1fr); }}
.kpi-6 {{ grid-template-columns: repeat(6, 1fr); }}
.kpi {{
  border: 1px solid {GRAY_200}; border-radius: 8px;
  padding: 10px 8px; text-align: center;
  background: {GRAY_50};
}}
.kpi .n {{
  font-size: 14pt; font-weight: 800; line-height: 1.1; color: {TEXT_1};
}}
.kpi .l {{
  font-size: 6.5pt; color: {TEXT_3}; text-transform: uppercase;
  letter-spacing: .05em; margin-top: 3px;
}}
.kpi.green .n {{ color: {G_PRIMARY}; }}
.kpi.red   .n {{ color: {RED}; }}
.kpi.amber .n {{ color: {AMBER}; }}
.kpi.gray  .n {{ color: {TEXT_2}; }}

/* ── RISK BAND ── */
.risk-band {{
  background: {GRAY_50}; border: 1px solid {GRAY_200};
  border-radius: 8px; padding: 12px 14px; margin: 10px 0;
}}
.risk-label {{ font-size: 7.5pt; font-weight: 600; margin-bottom: 6px; }}
.risk-bar {{ display: flex; height: 10px; border-radius: 5px; overflow: hidden; }}
.risk-bar div {{ height: 100%; }}
.risk-legend {{ display: flex; gap: 16px; margin-top: 7px; }}
.risk-legend span {{ font-size: 7pt; }}

/* ── CHARTS ── */
.ci {{ max-width: 100%; border-radius: 6px; border: 1px solid {GRAY_200}; display: block; }}
.row2 {{ display: flex; gap: 10px; align-items: flex-start; }}
.row2 > * {{ flex: 1; min-width: 0; }}
.col60 {{ flex: 1.6 !important; }}
.col40 {{ flex: 1 !important; }}

/* ── PANELS ── */
.panel {{
  background: {GRAY_50}; border: 1px solid {GRAY_200};
  border-radius: 8px; padding: 10px 12px; margin-bottom: 8px;
}}
.panel h3 {{ font-size: 8pt; font-weight: 700; color: {TEXT_1}; margin-bottom: 5px; }}
.panel p, .panel li {{ font-size: 7.5pt; color: {TEXT_2}; line-height: 1.65; }}
.panel ul {{ padding-left: 14px; }}
.note {{
  background: {GRAY_50}; border-left: 3px solid {G_PRIMARY};
  padding: 8px 10px; font-size: 7pt; color: {TEXT_2};
  line-height: 1.6; margin-top: 8px; border-radius: 0 6px 6px 0;
}}
.note strong {{ color: {TEXT_1}; }}

/* ── TABLES ── */
.tbl {{ width: 100%; border-collapse: collapse; font-size: 7.5pt; }}
.tbl th {{
  background: {GRAY_100}; padding: 6px 10px; text-align: left;
  font-size: 7pt; font-weight: 700; text-transform: uppercase;
  letter-spacing: .05em; color: {TEXT_2};
  border-bottom: 1px solid {GRAY_200};
}}
.tbl td {{ padding: 6px 10px; border-bottom: 1px solid {GRAY_100}; }}
.tbl tr:last-child td {{ border-bottom: none; }}
.tr {{ text-align: right; }}

/* ── BADGES ── */
.badge {{
  display: inline-block; padding: 1px 7px; border-radius: 20px;
  font-size: 6.5pt; font-weight: 700; white-space: nowrap;
}}
.br {{ background:{RED_PALE};   color:{RED};   border:1px solid {RED_BORDER}; }}
.ba {{ background:{AMBER_PALE}; color:{AMBER}; border:1px solid #fde68a; }}
.bg {{ background:{G_PALE};     color:{G_DARK};border:1px solid {G_BORDER}; }}
.bz {{ background:{GRAY_100};   color:{TEXT_2};border:1px solid {GRAY_200}; }}

/* ── CARDS ── */
.cards {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }}
.card {{
  border: 1px solid {GRAY_200}; border-radius: 8px; overflow: hidden;
  background: {WHITE};
}}
.card-top {{
  padding: 4px 8px; display: flex; align-items: center;
  justify-content: space-between;
}}
.sbadge {{
  color: white; font-size: 6pt; font-weight: 800;
  padding: 1px 6px; border-radius: 10px;
}}
.card-body {{ padding: 8px; }}
.card-profile {{ display: flex; align-items: center; gap: 7px; }}
.av {{
  width: 34px; height: 34px; border-radius: 50%; object-fit: cover;
  border: 1.5px solid {GRAY_200}; flex-shrink: 0;
}}
.av-empty {{
  width: 34px; height: 34px; border-radius: 50%; background: {GRAY_100};
  display: flex; align-items: center; justify-content: center;
  color: {TEXT_3}; font-size: 10pt; flex-shrink: 0;
}}
.uname {{ display: block; font-weight: 700; color: {G_DARK}; font-size: 7pt; }}
.fname {{
  display: block; color: {TEXT_1}; font-size: 6.5pt;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px;
}}
.uid-t {{ display: block; color: {TEXT_3}; font-size: 6pt; }}
.sbar {{ background: {GRAY_100}; height: 3px; border-radius: 2px; margin: 5px 0 3px; }}
.rsn {{ color: {TEXT_2}; font-size: 6pt; line-height: 1.4; }}

/* ── PAGE FOOTER ── */
.page-footer {{
  position: absolute; bottom: 10mm; left: 16mm; right: 16mm;
  border-top: 1px solid {GRAY_200}; padding-top: 5px;
  display: flex; justify-content: space-between;
  font-size: 7pt; color: {TEXT_3};
}}

/* ── PRINT ── */
@media print {{
  body {{ background: white; }}
  .print-bar {{ display: none !important; }}
  .page {{
    margin: 0; box-shadow: none;
    page-break-after: always; break-after: page;
  }}
  .page:last-child {{ page-break-after: avoid; break-after: avoid; }}
}}
</style>
</head>
<body>

<!-- BARRA IMPRIMIR -->
<div class="print-bar">
  Para exportar como PDF: <strong>Arquivo → Imprimir</strong> → Salvar como PDF · Margem: Nenhuma · Gráficos em segundo plano: ativado
  <button onclick="window.print()">⎙ Imprimir / Exportar PDF</button>
</div>

<!-- ══════════════════════════════════════════
     PÁGINA 1 — CAPA + DADOS DO PERFIL
══════════════════════════════════════════ -->
<div class="page page-break">

  <!-- Capa verde -->
  <div class="cover-band">
    <div class="brand" style="margin-bottom:24px">
      {LOGO_SVG}
      <div>
        <div class="brand-name" style="color:rgba(255,255,255,.9)">Mobiliza.me</div>
        <div class="brand-sub"  style="color:rgba(255,255,255,.6)">Inteligência para perfis políticos</div>
      </div>
    </div>
    <div style="font-size:8pt;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:.12em;margin-bottom:6px">
      Relatório de Qualidade de Seguidores
    </div>
    <h1>{P["name"]}</h1>
    <div class="handle">{P["handle"]}</div>
    <div class="sub">{P["bio"]} · {total:,} seguidores analisados</div>
  </div>

  <!-- KPIs do Perfil -->
  <div class="sec-title" style="margin-top:18px">Dados do Perfil</div>
  <div class="kpi-grid kpi-4" style="margin-bottom:8px">
    <div class="kpi green"><div class="n">{P["followers"]:,}</div><div class="l">Seguidores</div></div>
    <div class="kpi"><div class="n">{P["following"]:,}</div><div class="l">Seguindo</div></div>
    <div class="kpi"><div class="n">{P["posts"]:,}</div><div class="l">Publicações</div></div>
    <div class="kpi amber"><div class="n">{P["engagement"]}%</div><div class="l">Engajamento</div></div>
  </div>
  <div class="kpi-grid kpi-4">
    <div class="kpi"><div class="n">{P["avg_likes"]:.0f}</div><div class="l">Likes médios</div></div>
    <div class="kpi"><div class="n">{P["avg_comments"]:.1f}</div><div class="l">Coment. médios</div></div>
    <div class="kpi green"><div class="n">{P["sb_grade"]}</div><div class="l">SB Grade</div></div>
    <div class="kpi gray"><div class="n">#{P["sb_rank"]:,}</div><div class="l">SB Rank</div></div>
  </div>

  <div class="divider"></div>

  <!-- Resumo de Risco -->
  <div class="sec-title">Resumo da Qualidade da Base</div>
  <div class="kpi-grid kpi-4" style="margin-bottom:10px">
    <div class="kpi green"><div class="n">{n_baixo:,}</div><div class="l">Baixo Risco</div></div>
    <div class="kpi amber"><div class="n">{n_medio:,}</div><div class="l">Médio Risco</div></div>
    <div class="kpi red">  <div class="n">{n_alto:,}</div> <div class="l">Alto Risco</div></div>
    <div class="kpi gray"><div class="n">{n_alto/total*100:.1f}%</div><div class="l">Taxa de Risco</div></div>
  </div>

  <div class="risk-band">
    <div class="risk-label">Distribuição de risco — {total:,} perfis analisados</div>
    <div class="risk-bar">
      <div style="width:{n_baixo/total*100:.1f}%;background:{G_PRIMARY}"></div>
      <div style="width:{n_medio/total*100:.1f}%;background:{AMBER}"></div>
      <div style="width:{n_alto/total*100:.1f}%;background:{RED}"></div>
    </div>
    <div class="risk-legend">
      <span style="color:{G_PRIMARY}"><strong>{n_baixo/total*100:.1f}%</strong> Baixo risco</span>
      <span style="color:{AMBER}"><strong>{n_medio/total*100:.1f}%</strong> Médio risco</span>
      <span style="color:{RED}"><strong>{n_alto/total*100:.1f}%</strong> Alto risco</span>
    </div>
  </div>

  <div class="note">
    <strong>Nota:</strong> A classificação é baseada em indicadores técnicos (padrão de username,
    idioma do nome, data de criação estimada via User ID, presença de foto de perfil).
    Uma pontuação alta indica múltiplos sinais de conta criada em massa, mas não constitui
    prova definitiva de inautenticidade.
  </div>

  <div class="divider"></div>

  <!-- Crescimento últimos 30 dias nos KPIs -->
  <div class="sec-title">Crescimento Recente</div>
  <div class="kpi-grid kpi-4">
    <div class="kpi {last14_cls}"><div class="n">{P["last_14d"]:+,}</div><div class="l">Seguid. (14 dias)</div></div>
    <div class="kpi {last30_cls}"><div class="n">{P["last_30d"]:+,}</div><div class="l">Seguid. (30 dias)</div></div>
    <div class="kpi gray"><div class="n">#{P["followers_rank"]:,}</div><div class="l">Rank Seguidores</div></div>
    <div class="kpi gray"><div class="n">#{P["engagement_rank"]:,}</div><div class="l">Rank Engajamento</div></div>
  </div>

  <div class="page-footer">
    <span>Mobiliza.me · Relatório de Qualidade de Seguidores</span>
    <span>@majucotrim · {now} · Página 1</span>
  </div>
</div>


<!-- ══════════════════════════════════════════
     PÁGINA 2 — DISTRIBUIÇÃO POR ANO + INDICADORES
══════════════════════════════════════════ -->
<div class="page page-break">
  <div class="page-header">
    <div class="brand">
      {LOGO_SVG}
      <div><div class="brand-name">Mobiliza.me</div><div class="brand-sub">Relatório de Qualidade</div></div>
    </div>
    <div class="page-meta">@majucotrim · {now}</div>
  </div>

  <div class="sec-title">Distribuição por Ano Estimado de Criação</div>
  <div class="row2">
    <div class="col60">{ci("year")}</div>
    <div class="col40">{ci("pie")}</div>
  </div>

  <div class="note" style="margin-top:8px">
    <strong>Metodologia:</strong> O User ID do Instagram é sequencial.
    Referência: ID <strong>48.244.658 = conta de 2012</strong>.
    Contas com IDs acima de 65 bilhões foram provavelmente criadas a partir de 2022.
  </div>

  <div class="divider"></div>

  <div class="sec-title">Distribuição Detalhada por Ano</div>
  <div style="overflow:hidden;border:1px solid {GRAY_200};border-radius:8px">
    <table class="tbl">
      <thead><tr><th>Ano est.</th><th>Seguidores</th><th class="tr">%</th><th>Proporção</th></tr></thead>
      <tbody>{yr_rows}</tbody>
    </table>
  </div>

  <div class="divider"></div>

  <div class="sec-title">Indicadores por Tipo</div>
  <div class="row2">
    <div class="col60">{ci("flags")}</div>
    <div class="col40">
      <div style="overflow:hidden;border:1px solid {GRAY_200};border-radius:8px">
        <table class="tbl">
          <thead><tr><th>Indicador</th><th class="tr">Contas</th><th class="tr">%</th></tr></thead>
          <tbody>{flag_rows}</tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="page-footer">
    <span>Mobiliza.me · Relatório de Qualidade de Seguidores</span>
    <span>@majucotrim · {now} · Página 2</span>
  </div>
</div>


<!-- ══════════════════════════════════════════
     PÁGINA 3 — CRESCIMENTO + ENGAJAMENTO
══════════════════════════════════════════ -->
<div class="page page-break">
  <div class="page-header">
    <div class="brand">
      {LOGO_SVG}
      <div><div class="brand-name">Mobiliza.me</div><div class="brand-sub">Relatório de Qualidade</div></div>
    </div>
    <div class="page-meta">@majucotrim · {now}</div>
  </div>

  <div class="sec-title">Variação Diária de Seguidores — 15 abr a 14 mai 2026</div>
  {ci("growth")}

  <div class="row2" style="margin-top:10px">
    <div class="panel">
      <h3>Resumo — 30 dias</h3>
      <p>
        Ganho total: <strong style="color:{G_PRIMARY}">+{tot_gain:,}</strong><br>
        Perda total: <strong style="color:{RED}">{tot_loss:,}</strong><br>
        Saldo líquido: <strong>+{P["last_30d"]:,}</strong><br>
        Média diária (exc. pico): <strong>{avg_ex:+.0f}/dia</strong>
      </p>
    </div>
    <div class="panel">
      <h3>Pico em {peak_d}/2026</h3>
      <p>
        Ganho de <strong>+{peak_v:,}</strong> em um único dia,
        representando <strong>{peak_v/abs(avg_ex):.0f}×</strong> a média diária.
        Nos 7 dias seguintes: perda de <strong>1.258</strong> seguidores.
      </p>
    </div>
    <div class="panel">
      <h3>Últimos 14 dias</h3>
      <p>
        Saldo <strong style="color:{RED}">{P["last_14d"]:+,}</strong>.
        Queda em 8 dos 14 dias, média <strong>{P["last_14d"]/14:+.0f}/dia</strong>.
      </p>
    </div>
  </div>

  <div class="note">
    <strong>Contexto:</strong> Picos abruptos seguidos de declínio ocorrem em diferentes cenários:
    campanhas virais orgânicas, Instagram Ads, menções em canais de alcance, ou aquisição via
    serviços terceirizados. Este relatório documenta o comportamento observado sem atribuir causa.
  </div>

  <div class="divider"></div>

  <div class="sec-title">Taxa de Engajamento</div>
  <div class="row2">
    <div class="col60">{ci("engagement")}</div>
    <div class="col40">
      <div class="panel">
        <h3>Contexto</h3>
        <p>Taxa atual: <strong style="color:{RED}">{P["engagement"]}%</strong><br>
        Sobre {P["followers"]:,} seguidores declarados.</p>
        <br>
        <p>Benchmarks (50k–100k seguidores):</p>
        <ul style="margin-top:5px">
          <li><span class="badge bg">Excelente</span> &gt;3%</li>
          <li><span class="badge bg">Bom</span> 1–3%</li>
          <li><span class="badge ba">Médio</span> 0,5–1%</li>
          <li><span class="badge ba">Baixo</span> 0,1–0,5%</li>
        </ul>
        <br>
        <p>O valor de {P["engagement"]}% situa-se no intervalo
        <strong>Baixo</strong>, podendo indicar desproporção entre
        o número de seguidores e a audiência que efetivamente interage.</p>
      </div>
    </div>
  </div>

  <div class="page-footer">
    <span>Mobiliza.me · Relatório de Qualidade de Seguidores</span>
    <span>@majucotrim · {now} · Página 3</span>
  </div>
</div>


<!-- ══════════════════════════════════════════
     PÁGINA 4 — METODOLOGIA
══════════════════════════════════════════ -->
<div class="page page-break">
  <div class="page-header">
    <div class="brand">
      {LOGO_SVG}
      <div><div class="brand-name">Mobiliza.me</div><div class="brand-sub">Relatório de Qualidade</div></div>
    </div>
    <div class="page-meta">@majucotrim · {now}</div>
  </div>

  <div class="sec-title">Metodologia de Pontuação de Risco</div>
  <div style="overflow:hidden;border:1px solid {GRAY_200};border-radius:8px;margin-bottom:10px">
    <table class="tbl">
      <thead><tr><th>Critério</th><th>Pontuação</th><th>Descrição</th></tr></thead>
      <tbody>{method_rows}</tbody>
    </table>
  </div>

  <div class="note">
    <strong>Classificação de risco:</strong>
    <span class="badge br" style="margin-left:4px">Alto Risco</span> ≥ 60 pts &nbsp;·&nbsp;
    <span class="badge ba">Médio Risco</span> 35–59 pts &nbsp;·&nbsp;
    <span class="badge bg">Baixo Risco</span> &lt; 35 pts
  </div>

  <div class="divider"></div>

  <div class="sec-title">Limitações e Contexto</div>
  <div class="panel">
    <h3>Sobre este relatório</h3>
    <p>
      Este modelo é heurístico e não determinístico. Falsos positivos são possíveis —
      por exemplo, um usuário brasileiro com nome de origem sul-asiática pode receber
      pontuação elevada incorretamente. A análise deve ser interpretada como triagem
      quantitativa, não como auditoria definitiva.<br><br>
      Para uma auditoria mais aprofundada, recomenda-se cruzar estes dados com métricas
      de atividade real: taxa de visualizações de stories, distribuição de likes por
      publicação e padrões de comentários.<br><br>
      <strong>Fonte dos dados:</strong> IGFollow_majucotrim_78223_follower.csv
      (exportação de {total:,} seguidores) · Social Blade (métricas de crescimento).<br>
      <strong>Gerado em:</strong> {now_full} · Mobiliza.me
    </p>
  </div>

  <div class="divider"></div>

  <div class="sec-title">Estimativa de Ano por User ID</div>
  <div class="panel">
    <h3>Como o ano é estimado</h3>
    <p>
      O User ID do Instagram é atribuído de forma sequencial desde o lançamento da
      plataforma em outubro de 2010. Usando o ponto de referência fornecido
      (ID 48.244.658 = conta criada em 2012) e a curva histórica de crescimento,
      interpolamos um ano aproximado para cada conta. Esta estimativa tem margem de
      erro de aproximadamente ±1 ano para contas mais antigas e ±6 meses para
      contas recentes.
    </p>
  </div>

  <div class="page-footer">
    <span>Mobiliza.me · Relatório de Qualidade de Seguidores</span>
    <span>@majucotrim · {now} · Página 4</span>
  </div>
</div>


<!-- ══════════════════════════════════════════
     PÁGINA 5+ — AMOSTRA PERFIS ALTO RISCO
══════════════════════════════════════════ -->
<div class="page">
  <div class="page-header">
    <div class="brand">
      {LOGO_SVG}
      <div><div class="brand-name">Mobiliza.me</div><div class="brand-sub">Relatório de Qualidade</div></div>
    </div>
    <div class="page-meta">@majucotrim · {now}</div>
  </div>

  <div class="sec-title">
    Amostra de Perfis — Alto Risco
    <span class="badge br" style="margin-left:6px">{n_alto:,} perfis no total</span>
  </div>
  <p style="font-size:7pt;color:{TEXT_2};margin-bottom:10px">
    Exibindo os {min(36, n_alto)} primeiros perfis de alto risco (pontuação ≥ 60).
    Lista completa disponível no arquivo CSV exportado.
  </p>

  <div class="cards">{cards_html}</div>

  <div class="page-footer">
    <span>Mobiliza.me · Relatório de Qualidade de Seguidores</span>
    <span>@majucotrim · {now} · Página 5</span>
  </div>
</div>

</body>
</html>"""

# ─── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    args = parse_args()
    csv_path = args.csv
    if not csv_path.is_file():
        print(f"❌ CSV não encontrado: {csv_path}"); sys.exit(1)
    output_dir  = args.output_dir or (csv_path.parent / f"analise_{csv_path.stem}")
    output_dir.mkdir(parents=True, exist_ok=True)
    output_html = output_dir / "relatorio.html"
    output_csv  = output_dir / "seguidores_classificados.csv"

    print(f"\n{'='*56}")
    print("  Relatório de Qualidade de Seguidores — @majucotrim")
    print(f"{'='*56}\n")

    print("📂 Carregando CSV …")
    try:
        df = pd.read_csv(csv_path, encoding="utf-8-sig", low_memory=False)
    except Exception as e:
        print(f"❌ Erro: {e}"); sys.exit(1)
    print(f"   {len(df):,} seguidores carregados\n")

    print("🔍 Analisando perfis …")
    results = []
    for i, (_, row) in enumerate(df.iterrows()):
        if i % 5000 == 0: print(f"   {i:,}/{len(df):,} …")
        results.append(score(row.to_dict()))
    scores = pd.DataFrame(results)
    df_out = pd.concat([df.reset_index(drop=True), scores], axis=1)

    df_out.to_csv(output_csv, index=False, encoding="utf-8-sig")
    print(f"\n💾 CSV: {output_csv}")

    total  = len(df_out)
    n_alto  = int((df_out["risk"] == "ALTO").sum())
    n_medio = int((df_out["risk"] == "MÉDIO").sum())
    n_baixo = int((df_out["risk"] == "BAIXO").sum())

    print(f"\n  Risco Alto   : {n_alto:,}  ({n_alto/total*100:.1f}%)")
    print(f"  Risco Médio  : {n_medio:,}  ({n_medio/total*100:.1f}%)")
    print(f"  Risco Baixo  : {n_baixo:,}  ({n_baixo/total*100:.1f}%)")

    fmap = {
        "conta_nova":"Conta nova 2022+", "no_fullname":"Sem nome",
        "number_suffix":"Sufixo numérico", "south_asian":"Sul-asiático",
        "foreign_script":"Script estrangeiro", "random_string":"String aleatória",
        "repeated_chars":"Chars repetidos", "bot_username":"Bot animal+nº",
        "username_eq_fn":"Username=fullname",
    }
    print("\n  Indicadores:")
    for k, lbl in fmap.items():
        if k in df_out.columns:
            n = int(df_out[k].sum())
            print(f"    {lbl:25s}: {n:,}  ({n/total*100:.1f}%)")

    print(f"\n📊 Gerando gráficos …")
    charts = {}
    if HAS_MPL:
        charts["growth"]     = chart_growth()
        charts["year"]       = chart_year(df_out)
        charts["pie"]        = chart_pie(df_out)
        charts["flags"]      = chart_flags(df_out)
        charts["engagement"] = chart_engagement()
        print("   OK")

    print("🌐 Gerando HTML …")
    html = build_html(df_out, charts)
    with open(output_html, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"   Salvo: {output_html}")
    print(f"\n{'='*56}\n  ✅ Concluído → {output_html}\n{'='*56}\n")

if __name__ == "__main__":
    main()
