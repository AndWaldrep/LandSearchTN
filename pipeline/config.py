"""Study-area configuration for the East Tennessee retirement land search."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "cache"
RAW = CACHE / "raw"
OUT = ROOT.parent / "dashboard" / "data"
for p in (CACHE, RAW, OUT):
    p.mkdir(parents=True, exist_ok=True)

# Parcels are kept only if their centroid falls in this box (lon/lat).
# Covers Loudon + Blount counties and northern Monroe (Vonore / Tellico Village).
STUDY_BBOX = (-84.47, 35.50, -83.70, 35.93)
# Larger box for context data (roads, POIs, Knoxville hospitals, the Smokies crest).
CONTEXT_BBOX = (-84.60, 35.40, -83.35, 36.05)

# Metric CRS: NAD83 / Tennessee State Plane (meters)
CRS_M = "EPSG:32136"

MIN_ACRES = 0.5
MAX_ACRES = 500

# Parcel sources ------------------------------------------------------------
BLOUNT_URL = ("https://services3.arcgis.com/NIOS5f3vobGvnGtD/arcgis/rest/services/"
              "BlountParcels/FeatureServer/0")
HNTB_URL = ("https://services.arcgis.com/rD2ylXRs80UroD90/arcgis/rest/services/"
            "TN_County_Parcel_Map/FeatureServer")
HNTB_LAYERS = {"Loudon": (38, "Assessment_Data_53"), "Monroe": (29, "Assessment_Data_62")}
STATEWIDE_URL = ("https://services1.arcgis.com/YuVBSS7Y1of2Qud1/arcgis/rest/services/"
                 "Tennessee_Property_Boundaries_Public_Use/FeatureServer/0")

# Owners whose land is not realistically buyable.
EXCLUDE_OWNER_PATTERNS = [
    r"\bUNITED STATES\b", r"\bUSA\b", r"\bU S A\b", r"\bU\.S\.", r"NATIONAL PARK", r"\bTVA\b",
    r"TENNESSEE VALLEY AUTH", r"STATE OF TENNESSEE", r"\bTN DEPT\b", r"TENNESSEE DEPT",
    r"\bTWRA\b", r"WILDLIFE RESOURCES", r"\bCOUNTY\b", r"\bCITY OF\b", r"TOWN OF",
    r"UTILITY", r"UTILITIES", r"UTILITY BOARD", r"WATER (?:AUTHORITY|DISTRICT|DEPT|COMPANY|UTILITY)",
    r"ELECTRIC", r"\bPOWER\b", r"BOARD OF EDUCATION", r"SCHOOL", r"HOUSING AUTH",
    r"AIRPORT AUTH", r"METROPOLITAN KNOXVILLE AIRPORT", r"RAILROAD", r"RAILWAY", r"NORFOLK SOUTHERN",
    r"CHURCH", r"MINISTR", r"CEMETERY", r"BAPTIST", r"METHODIST", r"PRESBYTERIAN", r"CONGREGATION",
    r"HOMEOWNERS", r"PROPERTY OWNERS", r"\bPOA\b", r"\bHOA\b", r"OWNERS ASS", r"COMMUNITY ASS",
    r"COMMON AREA", r"TELLICO VILLAGE PROPERTY", r"TELLICO RESERVOIR DEV", r"DEVELOPMENT AGENCY",
    r"INDUSTRIAL DEV", r"\bIDB\b", r"CONSERVANCY", r"LAND TRUST", r"FOOTHILLS LAND",
    r"\bGAS\b", r"TELEPHONE", r"COMMUNICATIONS", r"\bAT&T\b", r"BELLSOUTH", r"ALCOA INC",
    r"ARCONIC", r"HOSPITAL", r"MARYVILLE COLLEGE", r"UNIVERSITY",
]
EXCLUDE_CLASSES = {"01", "02", "03", "04", "05", "06", "07", "08", "09", "15", "99"}

# Destinations for drive times (geocoded with OpenStreetMap Nominatim, Oct 2026).
TOWNS = {
    "Maryville": (35.7565, -83.9705),
    "Alcoa": (35.7847, -83.9866),
    "Louisville": (35.8217, -84.0480),
    "Friendsville": (35.7604, -84.1357),
    "Greenback": (35.6612, -84.1721),
    "Loudon": (35.7329, -84.3338),
    "Lenoir City": (35.7973, -84.2560),
    "Vonore": (35.5901, -84.2416),
    "Tellico Village": (35.6932, -84.2602),
    "Townsend": (35.6754, -83.7558),
    "Walland": (35.7281, -83.8132),
    "Madisonville": (35.5198, -84.3635),
}
KEY_DESTS = {
    "knoxville": ("Downtown Knoxville", (35.9606, -83.9207)),
    "maryville": ("Downtown Maryville", (35.7565, -83.9705)),
    "turkeycreek": ("Turkey Creek (Farragut)", (35.8960, -84.1530)),
    "airport": ("McGhee Tyson Airport (TYS)", (35.8096, -83.9989)),
    "townsend": ("Townsend / GSMNP entrance", (35.6754, -83.7558)),
}
# name, geocoder query, (lat, lon), tags
HOSPITALS = [
    ("Blount Memorial Hospital (Maryville)", "Blount Memorial Hospital, Maryville, Tennessee", (35.7567, -83.9589), {"ed"}),
    ("Fort Loudoun Medical Center (Lenoir City)", "Fort Loudoun Medical Center, Lenoir City, Tennessee", (35.8251, -84.2701), {"ed"}),
    ("Sweetwater Hospital", "Sweetwater Hospital, Sweetwater, Tennessee", (35.6010, -84.4645), {"ed"}),
    ("Parkwest Medical Center (Knoxville)", "Parkwest Medical Center, Knoxville, Tennessee", (35.9179, -84.1011), {"ed"}),
    ("Turkey Creek Medical Center (Farragut)", "Turkey Creek Medical Center, Knoxville, Tennessee", (35.8988, -84.1443), {"ed"}),
    ("Fort Sanders Regional (Knoxville)", "Fort Sanders Regional Medical Center, Knoxville, Tennessee", (35.9575, -83.9373), {"ed", "stroke"}),
    ("UT Medical Center (Knoxville) - Level I Trauma", "University of Tennessee Medical Center, Knoxville, Tennessee", (35.9401, -83.9435), {"ed", "trauma", "stroke"}),
    ("Methodist Medical Center (Oak Ridge)", "Methodist Medical Center, Oak Ridge, Tennessee", (36.0242, -84.2454), {"ed"}),
    ("Roane Medical Center (Harriman)", "Roane Medical Center, Harriman, Tennessee", (35.8884, -84.5552), {"ed"}),
]

# McGhee Tyson runways 5L/23R and 5R/23L (lat, lon ends; from OSM/Overture runway geometry)
TYS_RUNWAYS = [
    ((35.8034, -84.0066), (35.8229, -83.9829)),
    ((35.8001, -84.0040), (35.8176, -83.9826)),
]

OSRM_URL = "https://router.project-osrm.org"
