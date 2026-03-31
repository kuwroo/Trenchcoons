extends CharacterBody3D

@export var speed = 40.0
@export var detection_range = 80.0
@export var catch_distance = 5

var player = null

func _ready():
	player = get_tree().get_first_node_in_group("player")

func _physics_process(delta):
	if player == null:
		return

	var distance = global_position.distance_to(player.global_position)

	if distance < detection_range:
		var dir = (player.global_position - global_position).normalized()

		velocity.x = dir.x * speed
		velocity.z = dir.z * speed
		
		# gravity (important)
		if not is_on_floor():
			velocity.y -= 30 * delta
		else:
			velocity.y = 0

		move_and_slide()

		look_at(player.global_position)

		if distance < catch_distance:
			kill_player()
	else:
		velocity = Vector3.ZERO


func kill_player():
	if player:
		player.global_position = Vector3(0, 3, -60)
