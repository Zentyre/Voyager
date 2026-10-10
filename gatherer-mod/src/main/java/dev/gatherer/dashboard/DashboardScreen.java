package dev.gatherer.dashboard;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.ChatFormatting;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.util.FormattedCharSequence;
import com.mojang.blaze3d.platform.InputConstants;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The dashboard in game: the bots down the left (or the whole crew), what
 * the chosen one is up to, buttons for the usual commands, a box for any
 * other, and the log.
 */
public class DashboardScreen extends Screen {
	private static final String[][] QUICK = {
		{"Come", "come"}, {"Stop", "stop"}, {"Status", "status"}, {"Inventory", "inv"}, {"Eat", "eat"},
		{"Sleep", "sleep"}, {"Home", "home"}, {"Deposit", "deposit"}, {"Armor", "armor"}, {"Farm", "farm"},
	};
	private static final String CREW = "auto";
	private static final int WHITE = 0xFFFFFFFF, GREY = 0xFFAAAAAA, DIM = 0xFF777777, GREEN = 0xFF55FF55,
		RED = 0xFFFF5555, YELLOW = 0xFFFFFF55, AQUA = 0xFF55FFFF, PANEL = 0xB0000000;
	private static final int LINE = 10;

	// Kept between openings.
	private static String target = CREW;
	private static String draft = "";

	private final DashboardClient client;
	private List<String> labels;
	private final Map<String, Button> targetButtons = new LinkedHashMap<>();
	private EditBox command;
	private volatile String notice;
	private volatile boolean noticeBad;
	private volatile long noticeAt;

	private int listX, listW, mainX, mainW, detailsY, detailsH, quickY, commandY, logY;

	public DashboardScreen(DashboardClient client) {
		super(Component.literal("Gatherer"));
		this.client = client;
		client.soon();
		client.poll();
		labels = currentLabels();
	}

	private List<String> currentLabels() {
		List<String> out = new ArrayList<>();
		for (JsonElement b : client.bots()) {
			String label = str(b.getAsJsonObject(), "label");
			if (!label.isEmpty()) out.add(label);
		}
		return out;
	}

	@Override
	protected void init() {
		listX = 8;
		listW = Math.max(70, Math.min(110, width / 4));
		mainX = listX + listW + 10;
		mainW = width - 8 - mainX;
		detailsY = 24;
		detailsH = 6 * LINE + 6;
		quickY = detailsY + detailsH + 6;
		commandY = quickY + 44;
		logY = commandY + 26;

		addRenderableWidget(Button.builder(Component.literal("Settings"), b -> minecraft.setScreenAndShow(new SettingsScreen(this, client)))
			.bounds(width - 8 - 56, 4, 56, 16).build());

		targetButtons.clear();
		int y = detailsY;
		for (String label : withCrew()) {
			Button button = Button.builder(Component.literal(label), b -> target = label).bounds(listX, y, listW, 18).build();
			targetButtons.put(label, addRenderableWidget(button));
			y += 20;
		}
		updateTargetButtons();

		int cols = 5, gap = 3;
		int bw = (mainW - gap * (cols - 1)) / cols;
		for (int i = 0; i < QUICK.length; i++) {
			String text = QUICK[i][1];
			int x = mainX + (i % cols) * (bw + gap), by = quickY + (i / cols) * 22;
			addRenderableWidget(Button.builder(Component.literal(QUICK[i][0]), b -> send(text)).bounds(x, by, bw, 20).build());
		}

		command = new EditBox(font, mainX, commandY, mainW - 54, 20, Component.literal("Command"));
		command.setMaxLength(256);
		command.setHint(Component.literal("any command, e.g. get iron_ingot 16").withStyle(ChatFormatting.DARK_GRAY));
		command.setValue(draft);
		command.setResponder(v -> draft = v);
		addRenderableWidget(command);
		addRenderableWidget(Button.builder(Component.literal("Send"), b -> sendTyped()).bounds(mainX + mainW - 50, commandY, 50, 20).build());
		setInitialFocus(command);
	}

	private List<String> withCrew() {
		List<String> out = new ArrayList<>();
		out.add(CREW);
		out.addAll(labels);
		return out;
	}

	@Override
	public void tick() {
		client.poll();
		List<String> now = currentLabels();
		if (!now.equals(labels)) {
			labels = now;
			boolean typing = command != null && command.isFocused();
			rebuildWidgets();
			if (!typing) setFocused(null);
		}
		updateTargetButtons();
	}

	private void updateTargetButtons() {
		for (Map.Entry<String, Button> e : targetButtons.entrySet()) {
			String label = e.getKey();
			boolean chosen = label.equals(target);
			MutableComponent text;
			if (label.equals(CREW)) {
				text = Component.literal("Whole crew");
			} else {
				JsonObject b = bot(label);
				boolean online = b != null && bool(b, "online");
				text = Component.literal("● ").withStyle(online ? ChatFormatting.GREEN : ChatFormatting.DARK_GRAY)
					.append(Component.literal(b != null ? str(b, "name") : label).withStyle(online ? ChatFormatting.WHITE : ChatFormatting.GRAY));
			}
			e.getValue().setMessage(chosen ? Component.literal("» ").withStyle(ChatFormatting.YELLOW).append(text) : text);
		}
	}

	@Override
	public boolean keyPressed(KeyEvent event) {
		if (command != null && command.isFocused() && (event.key() == InputConstants.KEY_RETURN || event.key() == InputConstants.KEY_NUMPADENTER)) {
			sendTyped();
			return true;
		}
		return super.keyPressed(event);
	}

	private void sendTyped() {
		String text = command.getValue().trim();
		if (text.isEmpty()) return;
		send(text);
		command.setValue("");
	}

	private void send(String text) {
		String to = target;
		String who = to.equals(CREW) ? "the crew" : displayName(to);
		say("Sent to " + who + ": " + text, false);
		client.send(to, text).thenAccept(err -> {
			if (err != null) say(err, true);
		});
	}

	private void say(String text, boolean bad) {
		notice = text;
		noticeBad = bad;
		noticeAt = System.currentTimeMillis();
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float delta) {
		int listBottom = detailsY + 20 * (labels.size() + 1) + 2;
		g.fill(listX - 4, detailsY - 4, listX + listW + 4, Math.max(listBottom, detailsY + detailsH), PANEL);
		g.fill(mainX - 4, detailsY - 4, mainX + mainW + 4, detailsY + detailsH, PANEL);
		g.fill(mainX - 4, logY - 4, mainX + mainW + 4, height - 6, PANEL);

		super.extractRenderState(g, mouseX, mouseY, delta);

		g.text(font, "Gatherer", 8, 8, WHITE, true);
		int statusX = 8 + font.width("Gatherer") + 10;
		int statusW = width - 8 - 56 - 8 - statusX;
		String error = client.error;
		boolean fresh = System.currentTimeMillis() - noticeAt < 6000 && notice != null;
		if (fresh) g.text(font, fit(notice, statusW), statusX, 8, noticeBad ? RED : GREEN);
		else if (error != null) g.text(font, fit(error, statusW), statusX, 8, RED);
		else if (client.status == null) g.text(font, "Connecting to " + client.config.url + "...", statusX, 8, GREY);
		else g.text(font, fit(onlineCount() + " of " + labels.size() + " bots online", statusW), statusX, 8, GREY);

		if (target.equals(CREW)) crewDetails(g);
		else botDetails(g, bot(target));
		logLines(g);
	}

	private int onlineCount() {
		int n = 0;
		for (JsonElement b : client.bots()) if (bool(b.getAsJsonObject(), "online")) n++;
		return n;
	}

	private void crewDetails(GuiGraphicsExtractor g) {
		int y = detailsY;
		g.text(font, fit("Whole crew: jobs get shared out between them", mainW), mainX, y, YELLOW);
		y += LINE + 2;
		if (labels.isEmpty()) {
			g.text(font, client.status == null ? "Waiting for the dashboard..." : "No bots yet: start Gatherer.", mainX, y, GREY);
			return;
		}
		for (JsonElement e : client.bots()) {
			if (y > detailsY + detailsH - LINE) break;
			JsonObject b = e.getAsJsonObject();
			boolean online = bool(b, "online");
			String name = str(b, "name");
			g.text(font, name, mainX, y, online ? WHITE : DIM);
			int x = mainX + font.width(name) + 6;
			String rest = online ? health(b) + "  " + doing(b) : "offline";
			g.text(font, fit(rest, mainX + mainW - x), x, y, online ? GREY : DIM);
			y += LINE;
		}
	}

	private void botDetails(GuiGraphicsExtractor g, JsonObject b) {
		int y = detailsY;
		if (b == null) {
			g.text(font, "That bot isn't in the dashboard any more.", mainX, y, GREY);
			return;
		}
		boolean online = bool(b, "online");
		String state = str(b, "state");
		g.text(font, str(b, "name"), mainX, y, online ? WHITE : GREY, true);
		int x = mainX + font.width(str(b, "name")) + 8;
		g.text(font, online ? "online" : state.isEmpty() ? "offline" : state, x, y, online ? GREEN : DIM);
		y += LINE + 2;
		if (!online) {
			g.text(font, fit("Start it from the website dashboard.", mainW), mainX, y, GREY);
			return;
		}
		String level = b.has("xp") && !b.get("xp").isJsonNull() ? "   Level " + b.get("xp").getAsInt() : "";
		g.text(font, health(b) + level, mainX, y, WHITE);
		y += LINE;

		String where = "";
		if (b.has("position") && b.get("position").isJsonObject()) {
			JsonObject p = b.getAsJsonObject("position");
			where = "At " + num(p, "x") + " " + num(p, "y") + " " + num(p, "z");
			String dim = str(b, "dimension");
			if (!dim.isEmpty()) where += " (" + pretty(dim) + ")";
		}
		String held = str(b, "held");
		g.text(font, fit(where + (held.isEmpty() ? "" : "   Holding " + pretty(held)), mainW), mainX, y, GREY);
		y += LINE;

		g.text(font, fit(doing(b), mainW), mainX, y, AQUA);
		y += LINE;

		String job = "No job";
		if (b.has("task") && b.get("task").isJsonObject()) {
			JsonObject t = b.getAsJsonObject("task");
			job = "Job: " + pretty(str(t, "item")) + " " + num(t, "done") + "/" + num(t, "count");
		}
		JsonArray queue = b.has("queue") && b.get("queue").isJsonArray() ? b.getAsJsonArray("queue") : new JsonArray();
		if (!queue.isEmpty()) {
			List<String> next = new ArrayList<>();
			for (JsonElement q : queue) next.add(pretty(str(q.getAsJsonObject(), "item")) + " " + num(q.getAsJsonObject(), "count"));
			job += "   Then: " + String.join(", ", next);
		}
		g.text(font, fit(job, mainW), mainX, y, WHITE);
		y += LINE;

		StringBuilder carrying = new StringBuilder("Carrying: ");
		JsonArray inv = b.has("inventory") && b.get("inventory").isJsonArray() ? b.getAsJsonArray("inventory") : new JsonArray();
		if (inv.isEmpty()) carrying.append("nothing");
		for (int i = 0; i < inv.size(); i++) {
			JsonObject item = inv.get(i).getAsJsonObject();
			if (i > 0) carrying.append(", ");
			carrying.append(pretty(str(item, "name"))).append(" ").append(num(item, "count"));
		}
		String free = b.has("freeSlots") && !b.get("freeSlots").isJsonNull() ? b.get("freeSlots").getAsInt() + " free slots. " : "";
		g.text(font, fit(free + carrying, mainW), mainX, y, GREY);
	}

	/** The log, newest at the bottom, long lines wrapped. */
	private void logLines(GuiGraphicsExtractor g) {
		int top = logY, bottom = height - 8;
		if (bottom - top < LINE) return;
		JsonArray logs = client.logs();
		SimpleDateFormat clock = new SimpleDateFormat("HH:mm");
		List<FormattedCharSequence> lines = new ArrayList<>();
		int room = (bottom - top) / LINE;
		for (int i = logs.size() - 1; i >= 0 && lines.size() < room; i--) {
			JsonObject entry = logs.get(i).getAsJsonObject();
			String who = str(entry, "bot");
			MutableComponent line = Component.literal(clock.format(new Date(entry.has("t") ? entry.get("t").getAsLong() : 0)) + " ")
				.withStyle(ChatFormatting.DARK_GRAY);
			if (!who.isEmpty()) line.append(Component.literal(displayName(who) + ": ").withStyle(who.equals("you") ? ChatFormatting.YELLOW : ChatFormatting.AQUA));
			line.append(Component.literal(str(entry, "text")).withStyle(ChatFormatting.WHITE));
			List<FormattedCharSequence> wrapped = font.split(line, mainW);
			if (!lines.isEmpty() && lines.size() + wrapped.size() > room) break; // (no half entries at the top)
			lines.addAll(0, wrapped);
		}
		while (lines.size() > room) lines.remove(0);
		int y = bottom - lines.size() * LINE;
		for (FormattedCharSequence line : lines) {
			g.text(font, line, mainX, y, WHITE);
			y += LINE;
		}
		if (logs.isEmpty()) g.text(font, "Nothing in the log yet.", mainX, top, DIM);
	}

	// ---- bits ----

	private JsonObject bot(String label) {
		for (JsonElement b : client.bots()) {
			if (label.equals(str(b.getAsJsonObject(), "label"))) return b.getAsJsonObject();
		}
		return null;
	}

	private String displayName(String label) {
		JsonObject b = bot(label);
		return b != null && !str(b, "name").isEmpty() ? str(b, "name") : label;
	}

	private static String health(JsonObject b) {
		return "Health " + num(b, "health") + "/20  Food " + num(b, "food") + "/20";
	}

	private static String doing(JsonObject b) {
		if (b.has("doing") && b.get("doing").isJsonObject()) {
			JsonObject d = b.getAsJsonObject("doing");
			String step = str(d, "step");
			if (!step.isEmpty()) return step + (d.has("seconds") ? " (" + d.get("seconds").getAsInt() + "s)" : "");
			if (d.has("goals") && d.get("goals").isJsonArray() && !d.getAsJsonArray("goals").isEmpty()) {
				return d.getAsJsonArray("goals").get(d.getAsJsonArray("goals").size() - 1).getAsString();
			}
		}
		return bool(b, "busy") ? "Busy" : "Idle";
	}

	private String fit(String text, int w) {
		if (w <= 0) return "";
		if (font.width(text) <= w) return text;
		return font.plainSubstrByWidth(text, w - font.width("...")) + "...";
	}

	private static String pretty(String name) {
		return name.replaceFirst("^minecraft:", "").replace('_', ' ');
	}

	static String str(JsonObject o, String key) {
		JsonElement e = o == null ? null : o.get(key);
		return e != null && e.isJsonPrimitive() ? e.getAsString() : "";
	}

	private static String num(JsonObject o, String key) {
		JsonElement e = o.get(key);
		return e != null && e.isJsonPrimitive() ? String.valueOf(Math.round(e.getAsDouble())) : "?";
	}

	private static boolean bool(JsonObject o, String key) {
		JsonElement e = o.get(key);
		return e != null && e.isJsonPrimitive() && e.getAsBoolean();
	}
}
