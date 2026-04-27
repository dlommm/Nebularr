"""MyAnimeList API v2: maximal `fields` selection for GET /anime/{id} (public client-id auth)."""

# Per https://myanimelist.net/apiconfig/references/api/v2 — request whole objects
# without brace sub-selections; nested `field{sub}` strings often trigger redirects
# to `/error.json` on the live API.
MAL_ANIME_DETAIL_FIELDS = (
    "id,title,main_picture,alternative_titles,start_date,end_date,media_type,status,"
    "num_episodes,mean,nsfw,start_season,broadcast,synopsis,genres,studios"
)

MAL_API_BASE = "https://api.myanimelist.net/v2"
JIKAN_API_BASE = "https://api.jikan.moe/v4"

DEFAULT_DUB_INFO_URL = (
    "https://raw.githubusercontent.com/MAL-Dubs/MAL-Dubs/main/data/dubInfo.json"
)
