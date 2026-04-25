"""MyAnimeList API v2: maximal `fields` selection for GET /anime/{id} (public client-id auth)."""

# Nested subfields per https://myanimelist.net/apiconfig/references/api/v2
MAL_ANIME_DETAIL_FIELDS = (
    "id,title,main_picture{large,medium},alternative_titles{en,ja,synonyms},"
    "start_date,end_date,synopsis,mean,rank,popularity,num_list_users,num_scoring_users,"
    "nsfw,genres{id,name},created_at,updated_at,media_type,status,num_episodes,"
    "start_season{year,season},broadcast{day_of_the_week,start_time},source,average_episode_duration,"
    "rating,pictures{large,medium},background,"
    "studios{id,name},"
    "related_anime{node{id,title,main_picture{medium,large},alternative_titles{en}},relation_type,relation_type_formatted},"
    "related_manga{node{id,title,main_picture{medium,large}},relation_type,relation_type_formatted},"
    "recommendations{node{id,title,main_picture{medium}}},"
    "statistics{num_list_users,watching,completed,on_hold,dropped,plan_to_watch}"
)

MAL_API_BASE = "https://api.myanimelist.net/v2"
JIKAN_API_BASE = "https://api.jikan.moe/v4"

DEFAULT_DUB_INFO_URL = (
    "https://raw.githubusercontent.com/MAL-Dubs/MAL-Dubs/main/data/dubInfo.json"
)
