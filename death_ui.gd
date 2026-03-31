extends CanvasLayer

@onready var label = $Label
@onready var button = $Button

func _ready():
	visible = false
	button.pressed.connect(_on_restart_pressed)

func show_death_screen():
	visible = true

func _on_restart_pressed():
	get_tree().paused = false
	get_tree().reload_current_scene()
