extends CharacterBody3D

@onready var cam = $Camera3D

var speed = 0.0
var max_speed = 20.0
var acceleration = 30.0
var friction = 10.0
var turn_speed = 2.5

func _physics_process(delta):

	# 🚗 Movement (Player 2)
	if Input.is_action_pressed("accelerate"):
		speed += acceleration * delta
	elif Input.is_action_pressed("brake"):
		speed -= acceleration * delta
	else:
		speed = move_toward(speed, 0, friction * delta)

	speed = clamp(speed, -max_speed, max_speed)

	# 🚗 Steering (Player 1)
	var turn = 0.0
	if Input.is_action_pressed("steer_left"):
		turn += 1
	if Input.is_action_pressed("steer_right"):
		turn -= 1

	# smooth turning
	rotation.y += turn * turn_speed * delta

	# move forward
	velocity = transform.basis.z * speed
	move_and_slide()

	# 🎥 Camera follow
	var offset = -transform.basis.z * 8 + Vector3(0, 5, 0)
	var target_pos = global_transform.origin + offset
	cam.global_transform.origin = cam.global_transform.origin.lerp(target_pos, 0.1)
	cam.look_at(global_transform.origin)
