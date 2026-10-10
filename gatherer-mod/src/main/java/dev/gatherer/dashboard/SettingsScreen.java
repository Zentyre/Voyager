package dev.gatherer.dashboard;

import net.minecraft.ChatFormatting;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/** Where the dashboard is, and its access token. */
public class SettingsScreen extends Screen {
	private static final int WHITE = 0xFFFFFFFF, GREY = 0xFFAAAAAA;

	private final Screen parent;
	private final DashboardClient client;
	private EditBox url;
	private EditBox token;

	public SettingsScreen(Screen parent, DashboardClient client) {
		super(Component.literal("Gatherer dashboard settings"));
		this.parent = parent;
		this.client = client;
	}

	@Override
	protected void init() {
		int w = Math.min(320, width - 32);
		int x = (width - w) / 2;
		int y = height / 2 - 50;

		url = new EditBox(font, x, y + 12, w, 20, Component.literal("Dashboard address"));
		url.setMaxLength(512);
		url.setValue(client.config.url);
		url.setHint(Component.literal("http://127.0.0.1:3000").withStyle(ChatFormatting.DARK_GRAY));
		addRenderableWidget(url);

		token = new EditBox(font, x, y + 50, w, 20, Component.literal("Access token"));
		token.setMaxLength(256);
		token.setValue(client.config.token);
		token.setHint(Component.literal("not needed on the same computer").withStyle(ChatFormatting.DARK_GRAY));
		addRenderableWidget(token);

		addRenderableWidget(Button.builder(Component.literal("Save"), b -> save()).bounds(x, y + 86, w / 2 - 2, 20).build());
		addRenderableWidget(Button.builder(Component.literal("Cancel"), b -> onClose()).bounds(x + w / 2 + 2, y + 86, w / 2 - 2, 20).build());
		setInitialFocus(url);
	}

	private void save() {
		client.config.url = url.getValue();
		client.config.token = token.getValue();
		client.config.tidy();
		client.config.save();
		client.status = null;
		client.error = null;
		client.soon();
		onClose();
	}

	@Override
	public void onClose() {
		minecraft.setScreenAndShow(parent);
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float delta) {
		super.extractRenderState(g, mouseX, mouseY, delta);
		int w = Math.min(320, width - 32);
		int x = (width - w) / 2;
		int y = height / 2 - 50;
		g.centeredText(font, title, width / 2, y - 24, WHITE);
		g.text(font, "Dashboard address (or paste the whole link it printed)", x, y, GREY);
		g.text(font, "Access token", x, y + 38, GREY);
		g.text(font, "Saved in config/gatherer-dashboard.json", x, y + 112, GREY);
	}
}
