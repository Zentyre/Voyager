package dev.gatherer.dashboard;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.loader.api.FabricLoader;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * config/gatherer-dashboard.json: where the Gatherer dashboard is, and its
 * access token (only needed when it isn't on this computer).
 */
public class DashboardConfig {
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

	public String url = "http://127.0.0.1:3000";
	public String token = "";

	private static Path file() {
		return FabricLoader.getInstance().getConfigDir().resolve("gatherer-dashboard.json");
	}

	public static DashboardConfig load() {
		DashboardConfig config = new DashboardConfig();
		try {
			if (Files.exists(file())) {
				JsonObject json = JsonParser.parseString(Files.readString(file())).getAsJsonObject();
				if (json.has("url")) config.url = json.get("url").getAsString();
				if (json.has("token")) config.token = json.get("token").getAsString();
			} else {
				config.save();
			}
		} catch (Exception e) {
			GathererLog.warn("Couldn't read " + file() + ": " + e.getMessage());
		}
		config.tidy();
		return config;
	}

	public void save() {
		try {
			JsonObject json = new JsonObject();
			json.addProperty("url", url);
			json.addProperty("token", token);
			Files.createDirectories(file().getParent());
			Files.writeString(file(), GSON.toJson(json));
		} catch (Exception e) {
			GathererLog.warn("Couldn't save " + file() + ": " + e.getMessage());
		}
	}

	/**
	 * The whole link the dashboard prints (http://host:3000/?token=abc) works
	 * as the URL: the token is taken out of it.
	 */
	public void tidy() {
		url = url.trim();
		token = token.trim();
		if (url.isEmpty()) url = "http://127.0.0.1:3000";
		if (!url.matches("(?i)^https?://.*")) url = "http://" + url;
		try {
			URI uri = URI.create(url);
			String query = uri.getRawQuery();
			if (query != null) {
				for (String part : query.split("&")) {
					if (part.startsWith("token=") && part.length() > 6) token = part.substring(6);
				}
			}
			url = uri.getScheme() + "://" + uri.getRawAuthority();
		} catch (Exception e) {
			url = url.replaceAll("/+$", "");
		}
	}
}
