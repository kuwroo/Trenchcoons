extends CharacterBody3D

@export var speed = 40.0
@export var detection_range = 150.0

# 🔥 Adjust this path if your node name differs
@onready var anim = $Sketchfab_Scene2/AnimationPlayer

var player = null

func _ready():
	player = get_tree().get_first_node_in_group("player")

	# ▶️ Start running animation immediately
	if anim:
		anim.play("Take 001")


func _physics_process(delta):
	if player == null:
		return

	var distance = global_position.distance_to(player.global_position)

	# 🐺 Chase player
	if distance < detection_range:
		var dir = (player.global_position - global_position).normalized()

		velocity.x = dir.x * speed
		velocity.z = dir.z * speed

		# 🌍 Gravity
		if not is_on_floor():
			velocity.y -= 50 * delta
		else:
			velocity.y = 0

		move_and_slide()

		# 👀 Face player
		look_at(player.global_position, Vector3.UP)

	else:
		# idle stop
		velocity = Vector3.ZERO
		move_and_slide()


# 💀 Collision-based kill
func _on_area_3d_body_entered(body):
	if body.is_in_group("player"):
		body.die()
