package dev.gatherer.dashboard;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.loader.api.FabricLoader;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * config/gatherer-dashboard.json: the port of Gatherer's dashboard on this
 * computer (the same as "dashboard": { "port": ... } in Gatherer's config).
 */
public class DashboardConfig {
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

	public int port = 3000;

	private static Path file() {
		return FabricLoader.getInstance().getConfigDir().resolve("gatherer-dashboard.json");
	}

	public String url() {
		return "http://127.0.0.1:" + port;
	}

	public static DashboardConfig load() {
		DashboardConfig config = new DashboardConfig();
		try {
			JsonObject json = Files.exists(file()) ? JsonParser.parseString(Files.readString(file())).getAsJsonObject() : null;
			if (json != null && json.has("port") && json.get("port").isJsonPrimitive()) config.port = json.get("port").getAsInt();
			if (json == null) config.save();
		} catch (Exception e) {
			GathererLog.warn("Couldn't read " + file() + ": " + e.getMessage());
		}
		return config;
	}

	private void save() {
		try {
			JsonObject json = new JsonObject();
			json.addProperty("port", port);
			Files.createDirectories(file().getParent());
			Files.writeString(file(), GSON.toJson(json));
		} catch (Exception e) {
			GathererLog.warn("Couldn't save " + file() + ": " + e.getMessage());
		}
	}
}
