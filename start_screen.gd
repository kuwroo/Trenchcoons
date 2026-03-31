extends CanvasLayer

func _process(delta):
	var t = Time.get_ticks_msec() / 1000.0
	$Label.modulate.a = 0.5 + 0.5 * sin(t * 3.0)                              

func _input(event):                                                           
	if event.is_action_pressed("ui_accept"):                                  
		queue_free() 
