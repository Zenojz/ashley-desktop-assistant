// Every other Jarvis tool performs an action — open this, switch that, write a
// file. None of them return information, which is why asking about the weather
// could only ever open a browser tab and leave the user to read it themselves.
//
// This is the first tool that answers. It returns one short spoken sentence
// rather than structured data, because the caller is a voice model that will
// read the string aloud verbatim.
//
// Uses the same QWeather credentials as the HUD project, so a key that already
// works there can be copied across unchanged.

type QWeatherConfiguration = { host: string; apiKey: string };

type GeoResponse = {
  code?: string;
  location?: Array<{ name: string; adm1: string; adm2: string; lat: string; lon: string }>;
};

type NowResponse = {
  code?: string;
  now?: {
    temp: string;
    feelsLike: string;
    text: string;
    windDir: string;
    windScale: string;
    humidity: string;
  };
};

type ForecastResponse = {
  code?: string;
  daily?: Array<{
    fxDate: string;
    tempMax: string;
    tempMin: string;
    textDay: string;
    textNight: string;
  }>;
};

function getConfiguration(): QWeatherConfiguration | null {
  const host = process.env.QWEATHER_API_HOST?.trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
  const apiKey = process.env.QWEATHER_API_KEY?.trim();
  // Pin to QWeather's own domain so a mistyped host cannot redirect the key.
  if (!host || !apiKey || !/^(?:[a-z0-9-]+\.)+qweatherapi\.com$/i.test(host)) return null;
  return { host, apiKey };
}

async function request<T>(configuration: QWeatherConfiguration, path: string, query: Record<string, string>) {
  const url = new URL(`https://${configuration.host}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'X-QW-Api-Key': configuration.apiKey },
    // Nobody waits ten seconds for a spoken weather report; fail fast instead.
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`QWeather HTTP ${response.status}`);
  const data = await response.json() as T & { code?: string };
  if (data.code && data.code !== '200') throw new Error(`QWeather API ${data.code}`);
  return data;
}

async function resolveCity(configuration: QWeatherConfiguration, city: string) {
  const data = await request<GeoResponse>(configuration, '/geo/v2/city/lookup', {
    location: city,
    lang: 'zh'
  });
  const match = data.location?.[0];
  if (!match) throw new Error(`没有找到「${city}」这个地方。`);
  return match;
}

export type WeatherCoordinates = { latitude: number; longitude: number };

export async function describeWeather(
  rawCity: unknown,
  includeTomorrow: boolean,
  coordinates?: WeatherCoordinates | null
) {
  const configuration = getConfiguration();
  if (!configuration) throw new Error('还没有配置天气服务的密钥。');

  // Priority: a city the user actually named beats device location, which
  // beats the configured default. "上海天气怎么样" while sitting in 杭州 must
  // answer for 上海.
  const requested = typeof rawCity === 'string' ? rawCity.trim() : '';
  let location: { name: string; adm1: string; adm2: string; lat: string; lon: string };
  if (requested) {
    location = await resolveCity(configuration, requested);
  } else if (coordinates) {
    // QWeather's lookup accepts "lon,lat" and returns the nearest named place,
    // which doubles as the spoken location so the user hears a district name
    // rather than a pair of numbers.
    location = await resolveCity(configuration, `${coordinates.longitude},${coordinates.latitude}`);
  } else {
    const fallback = process.env.JARVIS_DEFAULT_CITY?.trim() || '';
    if (!fallback) throw new Error('不知道要查哪里的天气，请说出城市名。');
    location = await resolveCity(configuration, fallback);
  }
  const spokenPlace = location.adm2 && location.adm2 !== location.name
    ? `${location.adm2}${location.name}`
    : location.name;

  const now = await request<NowResponse>(configuration, '/v7/weather/now', {
    location: `${location.lon},${location.lat}`,
    lang: 'zh'
  });
  const current = now.now;
  if (!current) throw new Error('天气服务没有返回实况数据。');

  let sentence =
    `${spokenPlace}现在${current.text}，${current.temp}度` +
    (current.feelsLike && current.feelsLike !== current.temp ? `，体感${current.feelsLike}度` : '') +
    `，${current.windDir}${current.windScale}级，湿度百分之${current.humidity}。`;

  if (includeTomorrow) {
    // A failed forecast should not discard a perfectly good current reading.
    try {
      const forecast = await request<ForecastResponse>(configuration, '/v7/weather/3d', {
        location: `${location.lon},${location.lat}`,
        lang: 'zh'
      });
      const tomorrow = forecast.daily?.[1];
      if (tomorrow) {
        sentence += `明天${tomorrow.textDay}，${tomorrow.tempMin}到${tomorrow.tempMax}度。`;
      }
    } catch {
      // Keep the current conditions; silently drop the forecast.
    }
  }

  return sentence;
}
